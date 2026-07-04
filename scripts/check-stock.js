// Checks the shared gist for low-stock products and pings ntfy.sh if needed.
// Run daily by .github/workflows/check-stock.yml. No dependencies (Node >=20 global fetch).
const feedmath = require('../feedmath.js');

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
}

// Strip BOM/whitespace that can sneak in when secrets are piped in on Windows.
const clean = (s) => (s || '').replace(/^﻿/, '').trim();

async function main() {
  const GIST_TOKEN = clean(process.env.GIST_TOKEN);
  const GIST_ID = clean(process.env.GIST_ID);
  const NTFY_TOPIC = clean(process.env.NTFY_TOPIC);
  if (!GIST_TOKEN || !GIST_ID || !NTFY_TOPIC) {
    console.error('Missing required env vars: GIST_TOKEN, GIST_ID, NTFY_TOPIC');
    process.exit(1);
  }

  let state;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `Bearer ${GIST_TOKEN}` },
    });
    if (!res.ok) throw new Error(`gist fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    const file = data.files && data.files['feedapp.json'];
    if (!file) throw new Error('feedapp.json not found in gist');
    state = JSON.parse(file.content);
    // The gist starts as a bare placeholder before the app's first sync.
    state = Object.assign(
      { settings: { safetyDays: 3 }, products: [], horses: [], schedule: {}, logs: {}, purchases: [] },
      state
    );
  } catch (err) {
    console.error('Failed to load state from gist:', err.message);
    process.exit(1);
  }

  const today = todayUTC();
  const alerts = feedmath.checkAlerts(state, today);

  if (!alerts.length) {
    console.log('No low-stock alerts today.');
    process.exit(0);
  }

  const body = alerts
    .map((a) => `${a.name}: ${a.daysLeft.toFixed(1)} days left — buy by ${fmtDate(a.buyBy)}`)
    .join('\n');

  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      headers: { Title: 'Horse feed low', Priority: 'high' },
      body,
    });
    if (!res.ok) throw new Error(`ntfy post failed: HTTP ${res.status}`);
    console.log('Sent low-stock notification:\n' + body);
  } catch (err) {
    console.error('Failed to send ntfy notification:', err.message);
    process.exit(1);
  }
}

main();
