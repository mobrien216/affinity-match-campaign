'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Stripe = require('stripe');
const { Pool } = require('pg');
const { FUNDS, fundById, fundForSession } = require('./funds');

// ---------- Config ----------
const REQUIRED = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ADMIN_USER', 'ADMIN_PASSWORD', 'CAMPAIGN_START'];
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
// Default match amount per fund; each fund's can be changed on the admin page (fund_settings).
const GOAL_CENTS = parseInt(process.env.GOAL_CENTS || '1000000', 10);
const MAX_GOAL_CENTS = 100000000; // $1,000,000
if (!Number.isInteger(GOAL_CENTS) || GOAL_CENTS <= 0 || !/^\d+$/.test(process.env.GOAL_CENTS || '1000000')) {
  console.error('GOAL_CENTS must be a whole number of cents, e.g. 1000000 for $10,000');
  process.exit(1);
}
const CAMPAIGN_START = new Date(process.env.CAMPAIGN_START);
const CAMPAIGN_END = process.env.CAMPAIGN_END ? new Date(process.env.CAMPAIGN_END) : null;
if (Number.isNaN(CAMPAIGN_START.getTime()) || (CAMPAIGN_END && Number.isNaN(CAMPAIGN_END.getTime()))) {
  console.error('CAMPAIGN_START / CAMPAIGN_END must be ISO dates, e.g. 2026-11-17T00:00:00-05:00');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
// An idle connection dropping (e.g. a Render Postgres restart) emits 'error'; unhandled, it would crash the process.
pool.on('error', (err) => console.error('Idle database connection error:', err.message));

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

-- Per-fund display settings from the admin page. No row, or a NULL goal, means the defaults.
CREATE TABLE IF NOT EXISTS fund_settings (
  fund_id       TEXT PRIMARY KEY,
  show_progress BOOLEAN NOT NULL DEFAULT true,
  goal_cents    INTEGER CHECK (goal_cents > 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function loadFundSettings() {
  const { rows } = await pool.query('SELECT fund_id, show_progress, goal_cents FROM fund_settings');
  const byId = Object.fromEntries(rows.map((r) => [r.fund_id, r]));
  return Object.fromEntries(FUNDS.map((f) => {
    const s = byId[f.id];
    return [f.id, {
      show_progress: s ? s.show_progress : true,
      goal_cents: (s && s.goal_cents) || GOAL_CENTS,
      goal_is_default: !(s && s.goal_cents),
    }];
  }));
}

// ---------- Totals cache ----------
// The page polls every 30s; a 15s cache keeps DB load trivial even if the page goes viral.
let totalsCache = { at: 0, body: null };
const invalidateTotals = () => { totalsCache = { at: 0, body: null }; };

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

  let client;
  try {
    client = await pool.connect();
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
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(`Error processing ${event.type} ${event.id}:`, err);
    // 500 tells Stripe to retry later; the event row was rolled back so the retry is processed fresh.
    res.status(500).send('Processing error');
  } finally {
    if (client) client.release();
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
    if (totalsCache.body && Date.now() - totalsCache.at < 15000) return res.json(totalsCache.body);

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
      [LIVEMODE, CAMPAIGN_START, CAMPAIGN_END]
    );
    const settings = await loadFundSettings();
    const byFund = Object.fromEntries(rows.map((r) => [r.fund_id, r]));
    const now = new Date();

    const body = {
      campaign: {
        goal_cents: GOAL_CENTS,
        start: CAMPAIGN_START.toISOString(),
        end: CAMPAIGN_END ? CAMPAIGN_END.toISOString() : null,
        started: now >= CAMPAIGN_START,
        ended: CAMPAIGN_END ? now > CAMPAIGN_END : false,
        livemode: LIVEMODE,
      },
      funds: FUNDS.map((f) => {
        const { show_progress, goal_cents: goal } = settings[f.id];
        const base = { id: f.id, name: f.name, color: f.color, blurb: f.blurb, give_url: f.giveUrl, goal_cents: goal, show_progress };
        // Progress turned off: leave the figures out of the response too, not just off the page.
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

// ---------- Admin (manual gift entry and fund settings) ----------
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

// Express 4 doesn't catch rejected promises; without this a database error would crash the process.
const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);

app.use('/admin', requireAdmin, adminGuard);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.html')));

app.get('/admin/api/gifts', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, source, fund_id, amount_cents, refunded_cents, status, gift_date, note, entered_by
     FROM gifts WHERE livemode = $1 ORDER BY gift_date DESC, id DESC LIMIT 300`,
    [LIVEMODE]
  );
  const settings = await loadFundSettings();
  res.set('Cache-Control', 'no-store').json({
    funds: FUNDS.map((f) => ({ id: f.id, name: f.name, color: f.color, ...settings[f.id] })),
    campaign: {
      start: CAMPAIGN_START.toISOString(),
      end: CAMPAIGN_END ? CAMPAIGN_END.toISOString() : null,
      livemode: LIVEMODE,
      default_goal_cents: GOAL_CENTS,
    },
    gifts: rows,
  });
}));

// Save one fund's display settings. `goal` is in dollars; empty means use the default.
app.put('/admin/api/funds/:id', express.json({ limit: '2kb' }), asyncRoute(async (req, res) => {
  const fund = fundById(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  const { show_progress, goal } = req.body || {};
  if (typeof show_progress !== 'boolean') return res.status(400).json({ error: 'Choose whether to show progress.' });

  let goalCents = null;
  if (goal !== null && goal !== undefined && String(goal).trim() !== '') {
    goalCents = Math.round(Number(goal) * 100);
    if (!Number.isFinite(goalCents) || goalCents <= 0 || goalCents > MAX_GOAL_CENTS) {
      return res.status(400).json({ error: 'Enter a match amount between $0.01 and $1,000,000.' });
    }
  }

  await pool.query(
    `INSERT INTO fund_settings (fund_id, show_progress, goal_cents) VALUES ($1, $2, $3)
     ON CONFLICT (fund_id) DO UPDATE SET show_progress = EXCLUDED.show_progress, goal_cents = EXCLUDED.goal_cents, updated_at = now()`,
    [fund.id, show_progress, goalCents]
  );
  console.log(`Fund settings changed: ${fund.id} show_progress=${show_progress} goal_cents=${goalCents ?? 'default'}`);
  invalidateTotals();
  res.json({ ok: true, ...(await loadFundSettings())[fund.id] });
}));

app.post('/admin/api/gifts', express.json({ limit: '10kb' }), asyncRoute(async (req, res) => {
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
}));

app.post('/admin/api/gifts/:id/void', asyncRoute(async (req, res) => {
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

// ---------- Landing page ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Log the details; never send a stack trace to the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`${req.method} ${req.path} failed:`, err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Try again.' });
});

// ---------- Boot ----------
(async () => {
  await pool.query(SCHEMA);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Match campaign running on :${port} in ${LIVEMODE ? 'LIVE' : 'TEST'} mode`);
    for (const f of FUNDS) {
      if (!f.linkId || !f.giveUrl) console.warn(`Warning: ${f.id} is missing its Payment Link ID or URL`);
    }
  });
})().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
