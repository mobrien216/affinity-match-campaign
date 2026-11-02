'use strict';
// The three Affinity Funds. Payment Link IDs and URLs differ between Stripe test
// and live mode, so they come from environment variables, not code.
// `blurb` is optional approved copy shown on the landing page; leave '' until approved.

const FUNDS = [
  {
    id: 'fund_a',
    name: 'Black Philanthropy Fund',
    accountId: '452023',
    color: '#4B3B8F',
    blurb: '',
    linkId: process.env.FUND_A_LINK_ID || null,
    giveUrl: process.env.FUND_A_LINK_URL || null,
  },
  {
    id: 'fund_b',
    name: 'Latino Impacto Fund',
    accountId: '454778',
    color: '#B2452B',
    blurb: '',
    linkId: process.env.FUND_B_LINK_ID || null,
    giveUrl: process.env.FUND_B_LINK_URL || null,
  },
  {
    id: 'fund_c',
    name: 'LGBTQ+ Opportunity Fund',
    accountId: '452022',
    color: '#1C6E78',
    blurb: '',
    linkId: process.env.FUND_C_LINK_ID || null,
    giveUrl: process.env.FUND_C_LINK_URL || null,
  },
];

function fundById(id) {
  return FUNDS.find((f) => f.id === id) || null;
}

// Which fund a Checkout Session belongs to.
// 1) The Payment Link ID is the source of truth (set in env, can't be mistyped in the Dashboard).
// 2) Fall back to the fund_id metadata copied from the Payment Link onto the session.
// Sessions from any other link return null and are ignored.
function fundForSession(session) {
  if (session.payment_link) {
    const byLink = FUNDS.find((f) => f.linkId && f.linkId === session.payment_link);
    if (byLink) {
      const meta = session.metadata && session.metadata.fund_id;
      if (meta && meta !== byLink.id) {
        console.warn(`Session ${session.id}: metadata fund_id "${meta}" disagrees with link mapping "${byLink.id}". Using link mapping.`);
      }
      return byLink;
    }
  }
  const meta = session.metadata && session.metadata.fund_id;
  return meta ? fundById(meta) : null;
}

module.exports = { FUNDS, fundById, fundForSession };
