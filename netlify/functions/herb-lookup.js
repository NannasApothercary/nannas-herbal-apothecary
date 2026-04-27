// Nanna's Herbal Apothecary — server-side AI lookup
// Replaces the old browser-side BYO-API-key flow.
//
// Flow per request:
//   1. Validate input (type + query)
//   2. Cache lookup in Netlify Blobs (cache hit = free, instant)
//   3. Daily spend cap check ($1/day shared budget)
//   4. Per-IP rate limit (5 fresh searches per IP per day, bypass if X-Subscriber: 1)
//   5. Bot/UA filter (basic)
//   6. Anthropic API call (server-side key)
//   7. Save to cache, increment counters, return result
//
// Storage (Netlify Blobs, store name "nannas-cache"):
//   profile:{type}:{slug}     -> cached JSON profile (permanent until manually purged)
//   spend:YYYY-MM-DD          -> { dollars: <number>, calls: <number> }
//   ip:{hash}:YYYY-MM-DD      -> { count: <number> }   (only counts fresh, not cached)

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// --- Config ---
const DAILY_DOLLAR_CAP = 1.00;          // hard global cap per UTC day
const PER_IP_DAILY_LIMIT = 5;            // fresh (uncached) searches per IP per UTC day
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
// Conservative Haiku pricing (per million tokens).
// Adjust here if Anthropic publishes different rates.
const PRICE_INPUT_PER_MTOK = 1.00;
const PRICE_OUTPUT_PER_MTOK = 5.00;

// --- Prompt builders (mirrors what was previously inline in index.html) ---
function buildDrugPrompt(drug) {
  return `You are a medical herbalism expert reviewing peer-reviewed literature. A visitor to Nanna's Herbal Apothecary (run by Iola Herschell, RN) is looking for evidence-based herbal alternatives to: "${drug}".

Provide the top 3 evidence-based herbal alternatives. Return ONLY valid JSON in this exact format, no other text:

{
  "drug": "Full drug name and drug class",
  "remedies": [
    {
      "rank": 1,
      "name": "Herb Common Name",
      "latin": "Genus species",
      "efficacy": "High Evidence / Moderate Evidence / Emerging Evidence",
      "description": "2-3 sentence clinical overview",
      "howItWorks": "Mechanism of action explanation",
      "dosage": "Specific dosage recommendation",
      "sideEffects": ["side effect 1", "side effect 2", "side effect 3"],
      "whyBetter": "Why this may be preferable to the pharmaceutical",
      "studies": [
        {
          "title": "Journal: Study Title (Year)",
          "link": "https://pubmed.ncbi.nlm.nih.gov/?term=relevant+search+terms",
          "type": "Study type (RCT, Meta-Analysis, etc.)",
          "evidenceLevel": "High / Moderate / Emerging",
          "summary": "3-4 sentence plain-English summary of what the study did and found, with specific numbers where available",
          "finding": "One-sentence key finding with specific data"
        }
      ],
      "shopping": [
        {"name": "Product Name", "form": "Capsules/Loose Herb/Extract", "qty": "quantity", "basePrice": 14.99, "supplier": "Mountain Rose Herbs"},
        {"name": "Product Name", "form": "Capsules (60ct)", "qty": "1 bottle", "basePrice": 19.99, "supplier": "iHerb"}
      ]
    }
  ]
}

IMPORTANT: Only cite real studies with real PubMed search terms. Always include safety disclaimers in sideEffects. Note when herbs interact with medications.`;
}

function buildHerbPrompt(herb) {
  return `You are a medical herbalism expert. A visitor to Nanna's Herbal Apothecary (run by Iola Herschell, RN) wants to know about the herb: "${herb}".

Return ONLY valid JSON — no other text — in exactly this format:

{
  "name": "Herb Common Name",
  "latin": "Genus species",
  "icon": "🌿",
  "tags": ["tag1", "tag2", "tag3"],
  "overview": "2-3 sentence clinical overview of what this herb does and its traditional and modern uses.",
  "replacements": [
    {
      "rank": 1,
      "rx": "Drug Name (Brand/Generic)",
      "rxClass": "Drug class (e.g. ACE Inhibitor)",
      "condition": "condition treated (e.g. hypertension)",
      "evidence": "High Evidence / Moderate Evidence / Emerging Evidence",
      "mechanism": "How this herb works compared to the drug mechanism",
      "dosage": "Specific dosage recommendation with form",
      "notes": "Key safety notes, interactions, and contraindications"
    }
  ],
  "studies": [
    {
      "title": "Journal: Study Title (Year)",
      "link": "https://pubmed.ncbi.nlm.nih.gov/?term=relevant+search+terms",
      "journal": "Journal Name",
      "year": "2023",
      "type": "RCT / Meta-Analysis / Clinical Review",
      "evidenceLevel": "High / Moderate / Emerging",
      "summary": "3-4 sentence plain-English summary with specific numbers where available",
      "finding": "One-sentence key finding with specific data",
      "studyForm": "How the herb was administered in the study"
    }
  ],
  "shopping": [
    {"name": "Product Name", "form": "Loose Herb / Capsules / Extract", "qty": "amount", "basePrice": 12.99, "supplier": "Mountain Rose Herbs"},
    {"name": "Product Name", "form": "Capsules (60ct)", "qty": "1 bottle", "basePrice": 18.99, "supplier": "iHerb"}
  ],
  "contraindications": ["contraindication 1", "contraindication 2", "contraindication 3"]
}

IMPORTANT: Provide 2-3 replacements and 2-3 studies. Only cite real studies with real PubMed search terms. Always include safety warnings. Note drug interactions.`;
}

// --- Helpers ---
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function utcDateStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function hashIp(ip) {
  // Salt + hash so we never store raw IPs at rest.
  const salt = process.env.IP_HASH_SALT || 'nannas-default-salt-change-me';
  return crypto.createHash('sha256').update(salt + ':' + ip).digest('hex').slice(0, 24);
}

function looksLikeBot(ua) {
  if (!ua) return true;
  const s = ua.toLowerCase();
  return /bot|spider|crawl|curl|wget|python-requests|httpclient|scrapy/.test(s);
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders }
  });
}

// --- Main handler ---
export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const type = payload.type;
  const query = (payload.query || '').toString().trim();
  if (type !== 'drug' && type !== 'herb') {
    return jsonResponse(400, { error: 'type must be "drug" or "herb"' });
  }
  if (!query || query.length < 2 || query.length > 80) {
    return jsonResponse(400, { error: 'query must be 2–80 characters' });
  }

  const slug = slugify(query);
  if (!slug) {
    return jsonResponse(400, { error: 'query contains no usable characters' });
  }

  const store = getStore('nannas-cache');
  const cacheKey = `profile:${type}:${slug}`;

  // 1. Cache lookup — free path
  const cached = await store.get(cacheKey, { type: 'json' });
  if (cached) {
    return jsonResponse(200, { status: 'cached', data: cached });
  }

  // 2. Bot filter — bots get a polite no, never reach the API
  const ua = req.headers.get('user-agent') || '';
  if (looksLikeBot(ua)) {
    return jsonResponse(403, {
      status: 'blocked',
      error: 'Automated requests are not permitted. Please browse via the website.'
    });
  }

  // 3. Daily spend cap
  const dateStamp = utcDateStamp();
  const spendKey = `spend:${dateStamp}`;
  const spend = (await store.get(spendKey, { type: 'json' })) || { dollars: 0, calls: 0 };
  if (spend.dollars >= DAILY_DOLLAR_CAP) {
    return jsonResponse(503, {
      status: 'capped',
      error: "Today's AI search budget has been used up. Please try again tomorrow, or browse our pre-loaded herbs."
    });
  }

  // 4. Per-IP rate limit (skip if visitor is on the email list)
  const isSubscriber = req.headers.get('x-subscriber') === '1';
  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const ipKey = `ip:${hashIp(ip)}:${dateStamp}`;
  let ipRecord = (await store.get(ipKey, { type: 'json' })) || { count: 0 };
  if (!isSubscriber && ipRecord.count >= PER_IP_DAILY_LIMIT) {
    return jsonResponse(429, {
      status: 'rate_limited',
      error: 'You have used your free searches for today.',
      gateAction: 'subscribe'
    });
  }

  // 5. Anthropic API call
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: 'AI service is not configured (missing API key).' });
  }

  const prompt = type === 'drug' ? buildDrugPrompt(query) : buildHerbPrompt(query);

  let anthropicData;
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!apiRes.ok) {
      const errBody = await apiRes.json().catch(() => ({}));
      return jsonResponse(502, {
        status: 'upstream_error',
        error: errBody?.error?.message || `Anthropic returned ${apiRes.status}`
      });
    }
    anthropicData = await apiRes.json();
  } catch (e) {
    return jsonResponse(502, { status: 'upstream_error', error: e.message });
  }

  // 6. Parse JSON from response text
  const text = (anthropicData?.content?.[0]?.text || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return jsonResponse(502, {
      status: 'parse_error',
      error: 'AI response could not be parsed. Please try again.'
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    return jsonResponse(502, { status: 'parse_error', error: 'AI returned invalid JSON.' });
  }

  // 7. Compute cost from usage and update counters
  const usage = anthropicData.usage || {};
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cost = (inTok / 1_000_000) * PRICE_INPUT_PER_MTOK + (outTok / 1_000_000) * PRICE_OUTPUT_PER_MTOK;

  // Save cache (permanent — manually purge in Netlify dashboard if a profile needs refresh)
  await store.setJSON(cacheKey, {
    ...parsed,
    _meta: {
      cachedAt: new Date().toISOString(),
      model: ANTHROPIC_MODEL,
      cost: Number(cost.toFixed(5)),
      inputTokens: inTok,
      outputTokens: outTok
    }
  });

  // Increment daily spend
  await store.setJSON(spendKey, {
    dollars: Number((spend.dollars + cost).toFixed(5)),
    calls: spend.calls + 1
  });

  // Increment IP counter (subscribers don't count toward limit, but we still log it)
  await store.setJSON(ipKey, {
    count: ipRecord.count + 1,
    lastSeen: new Date().toISOString(),
    subscriber: isSubscriber
  });

  return jsonResponse(200, {
    status: 'fresh',
    data: parsed,
    remaining: isSubscriber ? null : Math.max(0, PER_IP_DAILY_LIMIT - (ipRecord.count + 1))
  });
};
