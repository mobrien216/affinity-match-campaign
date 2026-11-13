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

// Default match goal per fund, in cents. Each fund's goal can be changed at /admin.
const GOAL_RAW = process.env.GOAL_CENTS || '1000000';
const GOAL_CENTS = parseInt(GOAL_RAW, 10);
if (!/^\d+$/.test(GOAL_RAW) || GOAL_CENTS <= 0) {
  console.error('GOAL_CENTS must be a whole number of cents, e.g. 1000000 for $10,000');
  process.exit(1);
}
const MAX_GOAL_CENTS = 1000000000; // $10,000,000

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
// An idle connection dropping (e.g. a Render Postgres restart) emits 'error'; unhandled, it would crash the process.
pool.on('error', (err) => console.error('Idle database connection error:', err.message));

// Run fn(client) inside a transaction. Rolls back and rethrows on any error.
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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

CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refunds and lost disputes, keyed by PaymentIntent. Stripe can deliver these before the checkout
-- event that creates the gift, so they're kept here and applied whenever the gift row is written.
-- Rows for charges outside the campaign never match a gift and are harmless.
CREATE TABLE IF NOT EXISTS stripe_adjustments (
  payment_intent TEXT PRIMARY KEY,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  disputed_lost  BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- Per-fund settings, edited at /admin. A NULL match_goal_cents means use GOAL_CENTS.
CREATE TABLE IF NOT EXISTS fund_settings (
  fund_id           TEXT PRIMARY KEY,
  show_progress     BOOLEAN NOT NULL DEFAULT true,
  match_goal_cents  INTEGER CHECK (match_goal_cents IS NULL OR match_goal_cents > 0),
  updated_by        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every change to a fund setting. old_value / new_value are text so one table covers all settings.
CREATE TABLE IF NOT EXISTS fund_settings_log (
  id          SERIAL PRIMARY KEY,
  fund_id     TEXT NOT NULL,
  setting     TEXT,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade databases created by earlier versions. CREATE TABLE IF NOT EXISTS skips a table that
-- already exists, so add any columns this version needs. Safe to run on every startup.
ALTER TABLE fund_settings ADD COLUMN IF NOT EXISTS show_progress BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE fund_settings ADD COLUMN IF NOT EXISTS match_goal_cents INTEGER CHECK (match_goal_cents IS NULL OR match_goal_cents > 0);
ALTER TABLE fund_settings ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE fund_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE fund_settings_log ADD COLUMN IF NOT EXISTS setting TEXT;
ALTER TABLE fund_settings_log ADD COLUMN IF NOT EXISTS old_value TEXT;
ALTER TABLE fund_settings_log ADD COLUMN IF NOT EXISTS new_value TEXT;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE campaign_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  -- An earlier version stored the per-fund goal as fund_settings.goal_cents. Carry it over once.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'fund_settings' AND column_name = 'goal_cents') THEN
    UPDATE fund_settings SET match_goal_cents = goal_cents
     WHERE match_goal_cents IS NULL AND goal_cents IS NOT NULL;
  END IF;
  -- An earlier version logged only show_progress changes, in their own column.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'fund_settings_log' AND column_name = 'show_progress') THEN
    ALTER TABLE fund_settings_log ALTER COLUMN show_progress DROP NOT NULL;
    UPDATE fund_settings_log SET setting = 'show_progress', new_value = show_progress::text
     WHERE setting IS NULL;
  END IF;
END $$;
`;

// ---------- Caches ----------
// The page polls every 30s; a 15s cache keeps DB load trivial even if the page goes viral.
// Every write below clears the caches it affects, so admin changes show on the next poll.
const TOTALS_TTL_MS = 15000;
let totalsCache = { at: 0, body: null };
const invalidateTotals = () => { totalsCache = { at: 0, body: null }; };

let campaignCache = null;
async function getCampaign() {
  if (campaignCache) return campaignCache;
  const { rows } = await pool.query('SELECT start_at, end_at, updated_by, updated_at FROM campaign_settings WHERE id = 1');
  const r = rows[0];
  campaignCache = { start: r.start_at, end: r.end_at, updated_by: r.updated_by, updated_at: r.updated_at };
  return campaignCache;
}

// Settings for every fund, with defaults filled in, keyed by fund id.
let fundSettingsCache = null;
async function getFundSettings() {
  if (fundSettingsCache) return fundSettingsCache;
  const { rows } = await pool.query('SELECT fund_id, show_progress, match_goal_cents, updated_by, updated_at FROM fund_settings');
  const byId = Object.fromEntries(rows.map((r) => [r.fund_id, r]));
  fundSettingsCache = Object.fromEntries(FUNDS.map((f) => {
    const s = byId[f.id] || {};
    return [f.id, {
      show_progress: s.show_progress !== false,
      goal_cents: s.match_goal_cents || GOAL_CENTS,
      updated_by: s.updated_by || null,
      updated_at: s.updated_at || null,
    }];
  }));
  return fundSettingsCache;
}

const app = express();
app.disable('x-powered-by');

// Express 4 doesn't catch rejected promises in handlers; this passes them to the error handler below.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

  try {
    const fresh = await inTransaction(async (db) => {
      // Idempotency: Stripe retries and may deliver the same event more than once.
      const ins = await db.query(
        'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
        [event.id, event.type]
      );
      if (ins.rowCount === 0) return false;
      await handleEvent(db, event);
      return true;
    });
    if (!fresh) return res.json({ received: true, duplicate: true });
    invalidateTotals();
    res.json({ received: true });
  } catch (err) {
    console.error(`Error processing ${event.type} ${event.id}:`, err);
    // 500 tells Stripe to retry later; the event row was rolled back so the retry is processed fresh.
    res.status(500).send('Processing error');
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
      return recordAdjustment(db, obj.payment_intent, { refundedCents: obj.amount_refunded });

    case 'charge.dispute.closed':
      // Only subtract when the dispute is lost. Open or won disputes keep counting.
      if (obj.status !== 'lost' || !obj.payment_intent) return;
      return recordAdjustment(db, obj.payment_intent, { disputedLost: true });

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
  // A refund or lost dispute may have arrived before this gift existed.
  if (session.payment_intent) await applyAdjustments(db, session.payment_intent);
}

async function recordAdjustment(db, paymentIntent, { refundedCents = 0, disputedLost = false }) {
  // GREATEST: amount_refunded is cumulative, so an older refund event arriving late can't lower it.
  await db.query(
    `INSERT INTO stripe_adjustments (payment_intent, refunded_cents, disputed_lost)
     VALUES ($1, $2, $3)
     ON CONFLICT (payment_intent) DO UPDATE SET
       refunded_cents = GREATEST(stripe_adjustments.refunded_cents, EXCLUDED.refunded_cents),
       disputed_lost = stripe_adjustments.disputed_lost OR EXCLUDED.disputed_lost,
       updated_at = now()`,
    [paymentIntent, refundedCents, disputedLost]
  );
  await applyAdjustments(db, paymentIntent);
}

function applyAdjustments(db, paymentIntent) {
  return db.query(
    `UPDATE gifts g SET
       refunded_cents = GREATEST(g.refunded_cents, LEAST(a.refunded_cents, g.amount_cents)),
       status = CASE WHEN a.disputed_lost THEN 'disputed_lost' ELSE g.status END,
       updated_at = now()
     FROM stripe_adjustments a
     WHERE a.payment_intent = $1 AND g.stripe_payment_intent = a.payment_intent`,
    [paymentIntent]
  );
}

// ---------- Public API ----------
app.get('/api/totals', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (totalsCache.body && Date.now() - totalsCache.at < TOTALS_TTL_MS) return res.json(totalsCache.body);
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
        const { show_progress, goal_cents: goal } = settings[f.id];
        const base = { id: f.id, name: f.name, color: f.color, blurb: f.blurb, give_url: f.giveUrl, show_progress, goal_cents: goal };
        // Progress hidden in /admin: leave the figures out of the response too, not just off the page.
        if (!show_progress) return base;
        const raised = Number(byFund[f.id] ? byFund[f.id].raised_cents : 0);
        const matched = Math.min(raised, goal);
        return {
          ...base,
          raised_cents: raised,
          matched_cents: matched,
          over_goal_cents: Math.max(0, raised - goal),
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

// ---------- Admin ----------
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

// Browsers resend Basic Auth on cross-site form posts, so admin writes must carry a header that only
// the admin page's own fetch calls send (a cross-site page can't add one without a CORS preflight,
// which this server never approves). The admin page also refuses to be framed, to prevent clickjacking.
function adminGuard(req, res, next) {
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-requested-with') !== 'fetch') {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
}

// "Changed by" / "Entered by" initials, trimmed. Empty string if missing.
const whoFrom = (v) => String(v || '').trim().slice(0, 80);

app.use('/admin', requireAdmin, adminGuard);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.html')));

app.get('/admin/api/gifts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, source, fund_id, amount_cents, refunded_cents, status, gift_date, note, entered_by
     FROM gifts WHERE livemode = $1 ORDER BY gift_date DESC, id DESC LIMIT 300`,
    [LIVEMODE]
  );
  const campaign = await getCampaign();
  const settings = await getFundSettings();
  res.set('Cache-Control', 'no-store').json({
    funds: FUNDS.map((f) => ({ id: f.id, name: f.name, color: f.color, ...settings[f.id] })),
    campaign: {
      start: campaign.start.toISOString(),
      end: campaign.end ? campaign.end.toISOString() : null,
      updated_by: campaign.updated_by,
      updated_at: campaign.updated_at,
      livemode: LIVEMODE,
    },
    gifts: rows,
  });
}));

app.post('/admin/api/gifts', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const { fund_id, amount, gift_date, note, entered_by } = req.body || {};
  if (!fundById(fund_id)) return res.status(400).json({ error: 'Choose a fund.' });

  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > 100000000) {
    return res.status(400).json({ error: 'Enter an amount between $0.01 and $1,000,000.' });
  }
  const date = gift_date ? new Date(gift_date) : new Date();
  if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'Enter a valid gift date.' });
  const who = whoFrom(entered_by);
  if (!who) return res.status(400).json({ error: 'Enter your name or initials.' });

  const { rows } = await pool.query(
    `INSERT INTO gifts (source, fund_id, amount_cents, status, livemode, note, entered_by, gift_date)
     VALUES ('manual', $1, $2, 'paid', $3, $4, $5, $6) RETURNING id`,
    [fund_id, cents, LIVEMODE, String(note || '').slice(0, 200), who, date]
  );
  invalidateTotals();
  res.status(201).json({ id: rows[0].id });
}));

app.post('/admin/api/gifts/:id/void', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    return res.status(404).json({ error: 'Manual gift not found or already voided.' });
  }
  const { rowCount } = await pool.query(
    `UPDATE gifts SET status = 'voided', updated_at = now()
     WHERE id = $1 AND source = 'manual' AND livemode = $2 AND status = 'paid'`,
    [id, LIVEMODE]
  );
  if (!rowCount) return res.status(404).json({ error: 'Manual gift not found or already voided.' });
  invalidateTotals();
  res.json({ ok: true });
}));

// Change the campaign window. Takes effect immediately on the public totals.
app.put('/admin/api/campaign', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const { start, end, changed_by } = req.body || {};
  const newStart = new Date(start);
  const newEnd = end ? new Date(end) : null;
  if (!start || Number.isNaN(newStart.getTime())) return res.status(400).json({ error: 'Enter a valid start date and time.' });
  if (end && Number.isNaN(newEnd.getTime())) return res.status(400).json({ error: 'Enter a valid end date and time, or leave it blank.' });
  if (newEnd && newEnd <= newStart) return res.status(400).json({ error: 'The end must be after the start.' });
  const who = whoFrom(changed_by);
  if (!who) return res.status(400).json({ error: 'Enter your name or initials.' });

  await inTransaction(async (db) => {
    const { rows } = await db.query('SELECT start_at, end_at FROM campaign_settings WHERE id = 1 FOR UPDATE');
    await db.query(
      'INSERT INTO campaign_settings_log (old_start, old_end, new_start, new_end, changed_by) VALUES ($1, $2, $3, $4, $5)',
      [rows[0].start_at, rows[0].end_at, newStart, newEnd, who]
    );
    await db.query(
      'UPDATE campaign_settings SET start_at = $1, end_at = $2, updated_by = $3, updated_at = now() WHERE id = 1',
      [newStart, newEnd, who]
    );
  });
  campaignCache = null;
  invalidateTotals();
  console.log(`Campaign window changed by ${who}: ${newStart.toISOString()} to ${newEnd ? newEnd.toISOString() : 'no end'}`);
  res.json({ ok: true });
}));

// Change a fund's settings. Body may include show_progress (boolean: show or hide the amount raised,
// progress bar, and status lines) and/or match_goal (dollars). Each real change is logged with who made it.
app.put('/admin/api/funds/:id', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const fund = fundById(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Unknown fund.' });
  const { show_progress, match_goal, changed_by } = req.body || {};
  const who = whoFrom(changed_by);
  if (!who) return res.status(400).json({ error: 'Enter your name or initials first.' });

  // column names come from this fixed list, never from the request
  const changes = [];
  if (show_progress !== undefined) {
    if (typeof show_progress !== 'boolean') return res.status(400).json({ error: 'show_progress must be true or false.' });
    changes.push({ setting: 'show_progress', column: 'show_progress', value: show_progress });
  }
  if (match_goal !== undefined) {
    const cents = Math.round(Number(match_goal) * 100);
    if (!Number.isFinite(cents) || cents < 100 || cents > MAX_GOAL_CENTS) {
      return res.status(400).json({ error: 'Enter a match goal between $1 and $10,000,000.' });
    }
    changes.push({ setting: 'match_goal', column: 'match_goal_cents', value: cents });
  }
  if (!changes.length) return res.status(400).json({ error: 'Nothing to change.' });

  const before = (await getFundSettings())[fund.id];
  const current = { show_progress: before.show_progress, match_goal: before.goal_cents };
  const real = changes.filter((c) => c.value !== current[c.setting]);
  if (real.length) {
    await inTransaction(async (db) => {
      for (const c of real) {
        await db.query(
          `INSERT INTO fund_settings (fund_id, ${c.column}, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (fund_id) DO UPDATE SET ${c.column} = EXCLUDED.${c.column},
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [fund.id, c.value, who]
        );
        await db.query(
          'INSERT INTO fund_settings_log (fund_id, setting, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
          [fund.id, c.setting, String(current[c.setting]), String(c.value), who]
        );
      }
    });
    fundSettingsCache = null;
    invalidateTotals();
    console.log(`${fund.id} settings changed by ${who}: ${real.map((c) => `${c.setting}=${c.value}`).join(', ')}`);
  }
  res.json({ ok: true, changed: real.length > 0 });
}));

app.get('/admin/api/funds/log', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fund_id, setting, old_value, new_value, changed_by, changed_at
     FROM fund_settings_log ORDER BY changed_at DESC, id DESC LIMIT 100`
  );
  res.set('Cache-Control', 'no-store').json({ log: rows });
}));

app.get('/admin/api/campaign/log', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT old_start, old_end, new_start, new_end, changed_by, changed_at
     FROM campaign_settings_log ORDER BY changed_at DESC, id DESC LIMIT 50`
  );
  res.set('Cache-Control', 'no-store').json({ log: rows });
}));

// ---------- Landing page ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Any unhandled error in a route: log the details, never send a stack trace to the browser.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Something went wrong on the server. Try again, or check the Render logs.' });
});

// ---------- Boot ----------
(async () => {
  await pool.query(SCHEMA);
  // Seed the campaign window once, from env vars if present. Later edits happen in /admin.
  const seeded = await pool.query(
    `INSERT INTO campaign_settings (id, start_at, end_at, updated_by)
     VALUES (1, $1, $2, 'initial setup') ON CONFLICT (id) DO NOTHING RETURNING id`,
    [ENV_START || new Date(), ENV_END]
  );
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
