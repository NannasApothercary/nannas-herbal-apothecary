// Nanna's Herbal Apothecary — AI-lookup stats (read-only)
//
// Reports how the AI-generated profile "database" has grown and what it cost.
// Reads the same Netlify Blobs store the live lookup writes to ("nannas-cache"):
//
//   profile:{type}:{slug}  -> cached profile, _meta has { cachedAt, cost, ... }
//   spend:YYYY-MM-DD       -> { dollars, calls }  (authoritative daily spend tally)
//
// Protected by a shared secret. Call with:
//   GET /.netlify/functions/stats?token=YOUR_STATS_TOKEN
//
// Returns JSON: totals + per-month breakdown for both profiles and dollars.
// Nothing here writes or deletes — it is safe to call as often as you like.

import { getStore } from '@netlify/blobs';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function monthOf(isoOrDate) {
  // Accepts an ISO timestamp or a YYYY-MM-DD string, returns YYYY-MM.
  return String(isoOrDate || '').slice(0, 7);
}

export default async (req) => {
  // --- Auth: shared secret in STATS_TOKEN env var ---
  const expected = process.env.STATS_TOKEN;
  if (!expected) {
    return jsonResponse(500, { error: 'Stats endpoint not configured (missing STATS_TOKEN env var).' });
  }
  const url = new URL(req.url);
  const provided = url.searchParams.get('token') || req.headers.get('x-stats-token') || '';
  if (provided !== expected) {
    return jsonResponse(403, { error: 'Forbidden.' });
  }

  const store = getStore('nannas-cache');

  // --- 1. Walk all cached profiles ---
  const profilesByMonth = {};   // "YYYY-MM" -> { drug, herb, total, cost }
  let totalProfiles = 0, totalDrugs = 0, totalHerbs = 0;
  let profileCostTotal = 0;

  const profileList = await store.list({ prefix: 'profile:' });
  for (const blob of (profileList.blobs || [])) {
    const key = blob.key;                      // profile:{type}:{slug}
    const type = key.split(':')[1] || 'unknown';
    let rec;
    try { rec = await store.get(key, { type: 'json' }); } catch { rec = null; }
    const meta = (rec && rec._meta) || {};
    const month = monthOf(meta.cachedAt);
    const cost = Number(meta.cost || 0);

    totalProfiles++;
    profileCostTotal += cost;
    if (type === 'drug') totalDrugs++;
    else if (type === 'herb') totalHerbs++;

    if (month) {
      const m = (profilesByMonth[month] ||= { drug: 0, herb: 0, total: 0, cost: 0 });
      m.total++;
      m[type] = (m[type] || 0) + 1;
      m.cost = Number((m.cost + cost).toFixed(5));
    }
  }

  // --- 2. Walk the daily spend log (authoritative cost) ---
  const spendByMonth = {};      // "YYYY-MM" -> { dollars, calls }
  let totalDollars = 0, totalCalls = 0;

  const spendList = await store.list({ prefix: 'spend:' });
  for (const blob of (spendList.blobs || [])) {
    const day = blob.key.slice('spend:'.length);   // YYYY-MM-DD
    let rec;
    try { rec = await store.get(blob.key, { type: 'json' }); } catch { rec = null; }
    const dollars = Number((rec && rec.dollars) || 0);
    const calls = Number((rec && rec.calls) || 0);
    const month = monthOf(day);
    totalDollars += dollars;
    totalCalls += calls;
    const m = (spendByMonth[month] ||= { dollars: 0, calls: 0 });
    m.dollars = Number((m.dollars + dollars).toFixed(5));
    m.calls += calls;
  }

  // --- 3. This-month convenience figures ---
  const thisMonth = new Date().toISOString().slice(0, 7);
  const tmProfiles = profilesByMonth[thisMonth] || { drug: 0, herb: 0, total: 0, cost: 0 };
  const tmSpend = spendByMonth[thisMonth] || { dollars: 0, calls: 0 };

  return jsonResponse(200, {
    generatedAt: new Date().toISOString(),
    note: 'Profiles = drugs/herbs auto-generated for visitor searches outside the built-in database. The ~50 built-in drugs + 12 built-in herbs are free and not counted here.',
    totals: {
      profiles: totalProfiles,
      drugs: totalDrugs,
      herbs: totalHerbs,
      dollarsSpent: Number(totalDollars.toFixed(4)),
      apiCalls: totalCalls,
      profileCostCrossCheck: Number(profileCostTotal.toFixed(4))
    },
    thisMonth: {
      month: thisMonth,
      profilesAdded: tmProfiles.total,
      drugsAdded: tmProfiles.drug,
      herbsAdded: tmProfiles.herb,
      dollarsSpent: Number(tmSpend.dollars.toFixed(4))
    },
    byMonth: {
      profiles: profilesByMonth,
      spend: spendByMonth
    }
  });
};
