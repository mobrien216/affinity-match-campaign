'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Stripe = require('stripe');
const { Pool } = require('pg');
const { FUNDS, fundById, fundForSession } = require('./funds');

// ---------- Config ----------
const REQUIRED = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ADMIN_USER', 'ADMIN_PASSWORD'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Test vs live is decided by the key. Events from the other mode are ignored,
// and totals only include rows from the current mode, so test data never leaks into live totals.
const LIVEMODE = process.env.STRIPE_SECRET_KEY.includes('_live_');
const GOAL_CENTS = parseInt(process.env.GOAL_CENTS || '1000000', 10);
// Campaign dates live in the database and are edited at /admin.
// CAMPAIGN_START / CAMPAIGN_END env vars are used ONLY to seed the very first values;
// after that, changing them in Render has no effect.
const ENV_START = process.env.CAMPAIGN_START ? new Date(process.env.CAMPAIGN_START) : null;
const ENV_END = process.env.CAMPAIGN_END ? new Date(process.env.CAMPAIGN_END) : null;
if ((ENV_START && Number.isNaN(ENV_START.getTime())) || (ENV_END && Number.isNaN(ENV_END.getTime()))) {
  console.error('CAMPAIGN_START / CAMPAIGN_END must be ISO dates, e.g. 2026-11-17T00:00:00-05:00');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ---------- Schema (idempotent, runs on boot) ----------
// No donor names, emails, or card data are stored. Stripe remains the system of record for donors.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gifts (
  id                    SERIAL PRIMARY KEY,
  source                TEXT NOT NULL CHECK (source IN ('stripe', 'manual')),
  fund_id               TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_cents        INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'disputed_lost', 'voided')),
  livemode              BOOLEAN NOT NULL,
  stripe_session_id     TEXT UNIQUE,
  stripe_payment_intent TEXT UNIQUE,
  note                  TEXT,
  entered_by            TEXT,
  gift_date             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gifts_fund_idx ON gifts (fund_id, status, livemode);

CREATE TABLE IF NOT EXISTS campaign_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  start_at    TIMESTAMPTZ NOT NULL,
  end_at      TIMESTAMPTZ,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at IS NULL OR end_at > start_at)
);

-- Every change to the campaign window, for audit and finance reconciliation.
CREATE TABLE IF NOT EXISTS campaign_settings_log (
  id          SERIAL PRIMARY KEY,
  old_start   TIMESTAMPTZ,
  old_end     TIMESTAMPTZ,
  new_start   TIMESTAMPTZ NOT NULL,
  new_end     TIMESTAMPTZ,
  changed_by  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-fund display settings, edited at /admin.
CREATE TABLE IF NOT EXISTS fund_settings (
  fund_id        TEXT PRIMARY KEY,
  show_progress  BOOLEAN NOT NULL DEFAULT true,
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fund_settings_log (
  id             SERIAL PRIMARY KEY,
  fund_id        TEXT NOT NULL,
  show_progress  BOOLEAN NOT NULL,
  changed_by     TEXT NOT NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ---------- Totals cache ----------
// The page polls every 30s; a 15s cache keeps DB load trivial even if the page goes viral.
let totalsCache = { at: 0, body: null };
const invalidateTotals = () => { totalsCache = { at: 0, body: null }; };

// ---------- Campaign window (cached; cleared when edited in /admin) ----------
let fundSettingsCache = null;
async function getFundSettings() {
  if (fundSettingsCache) return fundSettingsCache;
  const { rows } = await pool.query('SELECT fund_id, show_progress, updated_by, updated_at FROM fund_settings');
  fundSettingsCache = Object.fromEntries(rows.map((r) => [r.fund_id, r]));
  return fundSettingsCache;
}

let campaignCache = null;
async function getCampaign() {
  if (campaignCache) return campaignCache;
  const { rows } = await pool.query('SELECT start_at, end_at, updated_by, updated_at FROM campaign_settings WHERE id = 1');
  const r = rows[0];
  campaignCache = { start: r.start_at, end: r.end_at, updated_by: r.updated_by, updated_at: r.updated_at };
  return campaignCache;
}

const app = express();
app.disable('x-powered-by');

// ---------- Stripe webhook ----------
// MUST be registered before any express.json() middleware: signature verification needs the raw body.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  if (event.livemode !== LIVEMODE) {
    return res.json({ received: true, ignored: 'mode mismatch' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Idempotency: Stripe retries and may deliver the same event more than once.
    const fresh = await client.query(
      'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
      [event.id, event.type]
    );
    if (fresh.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ received: true, duplicate: true });
    }
    await handleEvent(client, event);
    await client.query('COMMIT');
    invalidateTotals();
    res.json({ received: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Error processing ${event.type} ${event.id}:`, err);
    // 500 tells Stripe to retry later; the event row was rolled back so the retry is processed fresh.
    res.status(500).send('Processing error');
  } finally {
    client.release();
  }
});

async function handleEvent(db, event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return upsertSession(db, obj, event.created);

    case 'checkout.session.async_payment_failed':
      return upsertSession(db, obj, event.created, 'failed');

    case 'charge.refunded':
      // amount_refunded is cumulative, so partial and repeat refunds are handled correctly.
      if (!obj.payment_intent) return;
      return db.query(
        `UPDATE gifts SET refunded_cents = LEAST($1, amount_cents), updated_at = now()
         WHERE stripe_payment_intent = $2`,
        [obj.amount_refunded, obj.payment_intent]
      );

    case 'charge.dispute.closed':
      // Only subtract when the dispute is lost. Open or won disputes keep counting.
      if (obj.status !== 'lost' || !obj.payment_intent) return;
      return db.query(
        `UPDATE gifts SET status = 'disputed_lost', updated_at = now() WHERE stripe_payment_intent = $1`,
        [obj.payment_intent]
      );

    default:
      return; // Not an event we track.
  }
}

async function upsertSession(db, session, eventCreated, forcedStatus) {
  if (session.mode !== 'payment') return;
  const fund = fundForSession(session);
  if (!fund) {
    console.log(`Skipping session ${session.id}: not from a campaign Payment Link`);
    return;
  }

  let status = forcedStatus;
  if (!status) {
    if (session.payment_status === 'paid') status = 'paid';
    else if (session.payment_status === 'unpaid') status = 'pending'; // async methods (e.g. ACH) settle later
    else return; // no_payment_required
  }

  // amount_total = what the donor gave, before Stripe fees (the match counts gross).
  await db.query(
    `INSERT INTO gifts (source, fund_id, amount_cents, status, livemode, stripe_session_id, stripe_payment_intent, gift_date)
     VALUES ('stripe', $1, $2, $3, $4, $5, $6, to_timestamp($7))
     ON CONFLICT (stripe_session_id) DO UPDATE SET
       -- never downgrade a settled row back to pending if events arrive out of order
       status = CASE WHEN gifts.status = 'disputed_lost' OR EXCLUDED.status = 'pending'
                     THEN gifts.status ELSE EXCLUDED.status END,
       stripe_payment_intent = COALESCE(gifts.stripe_payment_intent, EXCLUDED.stripe_payment_intent),
       updated_at = now()`,
    [fund.id, session.amount_total, status, session.livemode, session.id, session.payment_intent || null, eventCreated]
  );
}

// ---------- Public API ----------
app.get('/api/totals', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (totalsCache.body && Date.now() - totalsCache.at < 15000) return res.json(totalsCache.body);
    const campaign = await getCampaign();
    const settings = await getFundSettings();
    const { rows } = await pool.query(
      `SELECT fund_id,
              COALESCE(SUM(amount_cents - refunded_cents), 0)::bigint AS raised_cents,
              COUNT(*) FILTER (WHERE amount_cents > refunded_cents)::int AS gift_count
       FROM gifts
       WHERE status = 'paid'
         AND livemode = $1
         AND gift_date >= $2
         AND ($3::timestamptz IS NULL OR gift_date <= $3)
       GROUP BY fund_id`,
      [LIVEMODE, campaign.start, campaign.end]
    );
    const byFund = Object.fromEntries(rows.map((r) => [r.fund_id, r]));
    const now = new Date();

    const body = {
      campaign: {
        goal_cents: GOAL_CENTS,
        start: campaign.start.toISOString(),
        end: campaign.end ? campaign.end.toISOString() : null,
        started: now >= campaign.start,
        ended: campaign.end ? now > campaign.end : false,
        livemode: LIVEMODE,
      },
      funds: FUNDS.map((f) => {
        const raised = Number(byFund[f.id] ? byFund[f.id].raised_cents : 0);
        const matched = Math.min(raised, GOAL_CENTS);
        const show = settings[f.id] ? settings[f.id].show_progress : true;
        const base = { id: f.id, name: f.name, color: f.color, blurb: f.blurb, give_url: f.giveUrl, show_progress: show };
        // When progress is hidden, the public API doesn't send the numbers at all.
        if (!show) return base;
        return {
          ...base,
          raised_cents: raised,
          matched_cents: matched,
          over_goal_cents: Math.max(0, raised - GOAL_CENTS),
          total_with_match_cents: raised + matched,
          gift_count: byFund[f.id] ? byFund[f.id].gift_count : 0,
        };
      }),
      updated_at: now.toISOString(),
    };
    totalsCache = { at: Date.now(), body };
    res.json(body);
  } catch (err) {
    console.error('Totals query failed:', err);
    res.status(503).json({ error: 'Totals are temporarily unavailable.' });
  }
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, livemode: LIVEMODE });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ---------- Admin (manual gift entry) ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (idx > 0 && safeEqual(user, process.env.ADMIN_USER) && safeEqual(pass, process.env.ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Affinity Funds match admin", charset="UTF-8"');
  res.status(401).send('Authentication required');
}

app.use('/admin', requireAdmin);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.html')));

app.get('/admin/api/gifts', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, source, fund_id, amount_cents, refunded_cents, status, gift_date, note, entered_by
     FROM gifts WHERE livemode = $1 ORDER BY gift_date DESC, id DESC LIMIT 300`,
    [LIVEMODE]
  );
  const campaign = await getCampaign();
  const settings = await getFundSettings();
  res.set('Cache-Control', 'no-store').json({
    funds: FUNDS.map((f) => ({
      id: f.id,
      name: f.name,
      show_progress: settings[f.id] ? settings[f.id].show_progress : true,
      settings_updated_by: settings[f.id] ? settings[f.id].updated_by : null,
      settings_updated_at: settings[f.id] ? settings[f.id].updated_at : null,
    })),
    campaign: {
      start: campaign.start.toISOString(),
      end: campaign.end ? campaign.end.toISOString() : null,
      updated_by: campaign.updated_by,
      updated_at: campaign.updated_at,
      livemode: LIVEMODE,
    },
    gifts: rows,
  });
});

app.post('/admin/api/gifts', express.json({ limit: '10kb' }), async (req, res) => {
  const { fund_id, amount, gift_date, note, entered_by } = req.body || {};
  if (!fundById(fund_id)) return res.status(400).json({ error: 'Choose a fund.' });

  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > 100000000) {
    return res.status(400).json({ error: 'Enter an amount greater than $0.' });
  }
  const date = gift_date ? new Date(gift_date) : new Date();
  if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'Enter a valid gift date.' });
  if (!entered_by || !String(entered_by).trim()) return res.status(400).json({ error: 'Enter your name or initials.' });

  const { rows } = await pool.query(
    `INSERT INTO gifts (source, fund_id, amount_cents, status, livemode, note, entered_by, gift_date)
     VALUES ('manual', $1, $2, 'paid', $3, $4, $5, $6) RETURNING id`,
    [fund_id, cents, LIVEMODE, String(note || '').slice(0, 200), String(entered_by).trim().slice(0, 80), date]
  );
  invalidateTotals();
  res.status(201).json({ id: rows[0].id });
});

app.post('/admin/api/gifts/:id/void', async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE gifts SET status = 'voided', updated_at = now()
     WHERE id = $1 AND source = 'manual' AND livemode = $2 AND status = 'paid'`,
    [parseInt(req.params.id, 10), LIVEMODE]
  );
  if (!rowCount) return res.status(404).json({ error: 'Manual gift not found or already voided.' });
  invalidateTotals();
  res.json({ ok: true });
});

// Change the campaign window. Takes effect immediately on the public totals.
app.put('/admin/api/campaign', express.json({ limit: '10kb' }), async (req, res) => {
  const { start, end, changed_by } = req.body || {};
  const newStart = new Date(start);
  const newEnd = end ? new Date(end) : null;
  if (!start || Number.isNaN(newStart.getTime())) return res.status(400).json({ error: 'Enter a valid start date and time.' });
  if (end && Number.isNaN(newEnd.getTime())) return res.status(400).json({ error: 'Enter a valid end date and time, or leave it blank.' });
  if (newEnd && newEnd <= newStart) return res.status(400).json({ error: 'The end must be after the start.' });
  const who = String(changed_by || '').trim().slice(0, 80);
  if (!who) return res.status(400).json({ error: 'Enter your name or initials.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT start_at, end_at FROM campaign_settings WHERE id = 1 FOR UPDATE');
    await client.query(
      `INSERT INTO campaign_settings_log (old_start, old_end, new_start, new_end, changed_by) VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].start_at, rows[0].end_at, newStart, newEnd, who]
    );
    await client.query(
      `UPDATE campaign_settings SET start_at = $1, end_at = $2, updated_by = $3, updated_at = now() WHERE id = 1`,
      [newStart, newEnd, who]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Campaign update failed:', err);
    return res.status(500).json({ error: 'Dates were not saved. Try again.' });
  } finally {
    client.release();
  }
  campaignCache = null;
  invalidateTotals();
  console.log(`Campaign window changed by ${who}: ${newStart.toISOString()} to ${newEnd ? newEnd.toISOString() : 'no end'}`);
  res.json({ ok: true });
});

// Show or hide a fund's progress (amount, bar, and status lines) on the public page.
app.put('/admin/api/funds/:id', express.json({ limit: '10kb' }), async (req, res) => {
  const fund = fundById(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Unknown fund.' });
  const { show_progress, changed_by } = req.body || {};
  if (typeof show_progress !== 'boolean') return res.status(400).json({ error: 'show_progress must be true or false.' });
  const who = String(changed_by || '').trim().slice(0, 80);
  if (!who) return res.status(400).json({ error: 'Enter your name or initials first.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fund_settings SET show_progress = $1, updated_by = $2, updated_at = now() WHERE fund_id = $3`,
      [show_progress, who, fund.id]
    );
    await client.query(
      `INSERT INTO fund_settings_log (fund_id, show_progress, changed_by) VALUES ($1, $2, $3)`,
      [fund.id, show_progress, who]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fund setting update failed:', err);
    return res.status(500).json({ error: 'Setting was not saved. Try again.' });
  } finally {
    client.release();
  }
  fundSettingsCache = null;
  invalidateTotals();
  console.log(`${fund.id} progress ${show_progress ? 'shown' : 'hidden'} by ${who}`);
  res.json({ ok: true });
});

app.get('/admin/api/campaign/log', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT old_start, old_end, new_start, new_end, changed_by, changed_at FROM campaign_settings_log ORDER BY changed_at DESC LIMIT 50'
  );
  res.set('Cache-Control', 'no-store').json({ log: rows });
});

// ---------- Landing page ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- Boot ----------
(async () => {
  await pool.query(SCHEMA);
  // Seed the campaign window once, from env vars if present. Later edits happen in /admin.
  const seeded = await pool.query(
    `INSERT INTO campaign_settings (id, start_at, end_at, updated_by)
     VALUES (1, $1, $2, 'initial setup') ON CONFLICT (id) DO NOTHING RETURNING id`,
    [ENV_START || new Date(), ENV_END]
  );
  for (const f of FUNDS) {
    await pool.query('INSERT INTO fund_settings (fund_id) VALUES ($1) ON CONFLICT (fund_id) DO NOTHING', [f.id]);
  }
  const c = await getCampaign();
  console.log(`Campaign window${seeded.rowCount ? ' (seeded from env)' : ''}: ${c.start.toISOString()} to ${c.end ? c.end.toISOString() : 'no end'}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Match campaign running on :${port} in ${LIVEMODE ? 'LIVE' : 'TEST'} mode`);
    for (const f of FUNDS) {
      if (!f.linkId || !f.giveUrl) console.warn(`Warning: ${f.id} is missing its Payment Link ID or URL`);
      if (f.giveUrl && !f.giveUrl.startsWith('https://')) console.warn(`Warning: ${f.id} URL should start with https:// (got "${f.giveUrl.slice(0, 20)}…")`);
      if (f.linkId && !f.linkId.startsWith('plink_')) console.warn(`Warning: ${f.id} link ID should start with plink_ (got "${f.linkId.slice(0, 12)}…")`);
    }
  });
})().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
