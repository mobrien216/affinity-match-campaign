'use strict';
// The three Affinity Funds. Payment Link IDs and URLs differ between Stripe test
// and live mode, so they come from environment variables, not code.
// `blurb` is optional approved copy shown on the landing page; leave '' until approved.

const FUNDS = [
  {
    id: 'fund_a',
    name: 'Black Philanthropy Fund',
    accountId: '452023',
    color: '#EE7331', // TCF Orange
    blurb: '',
    linkId: process.env.FUND_A_LINK_ID || null,
    giveUrl: process.env.FUND_A_LINK_URL || null,
  },
  {
    id: 'fund_b',
    name: 'Latino Impacto Fund',
    accountId: '454778',
    color: '#1A8DA9', // TCF Blue
    blurb: '',
    linkId: process.env.FUND_B_LINK_ID || null,
    giveUrl: process.env.FUND_B_LINK_URL || null,
  },
  {
    id: 'fund_c',
    name: 'LGBTQ+ Opportunity Fund',
    accountId: '452022',
    color: '#C0629A', // TCF Pink (affinity fund-type color)
    blurb: '',
    linkId: process.env.FUND_C_LINK_ID || null,
    giveUrl: process.env.FUND_C_LINK_URL || null,
  },
];

function fundById(id) {
  return FUNDS.find((f) => f.id === id) || null;
}

// Which fund a Checkout Session belongs to.
// The Payment Link ID (set in env) is the source of truth. If a session came from a
// Payment Link that is NOT one of the three campaign links, it doesn't count, even if
// that link carries the same fund_id metadata (e.g. older links still posted elsewhere).
// The fund_id metadata is only used for sessions that didn't come from a Payment Link.
function fundForSession(session) {
  const meta = session.metadata && session.metadata.fund_id;
  if (session.payment_link) {
    const byLink = FUNDS.find((f) => f.linkId && f.linkId === session.payment_link);
    if (!byLink) return null;
    if (meta && meta !== byLink.id) {
      console.warn(`Session ${session.id}: metadata fund_id "${meta}" disagrees with link mapping "${byLink.id}". Using link mapping.`);
    }
    return byLink;
  }
  return meta ? fundById(meta) : null;
}

module.exports = { FUNDS, fundById, fundForSession };
