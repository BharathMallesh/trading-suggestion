// News brief: recent headlines for a company, filtered for relevance, then
// summarised by Ling with a sentiment score.
// Sources: Google News RSS (India edition, last 7 days) for NSE/BSE symbols —
// the free Yahoo feed barely covers Indian companies — and the Yahoo search
// endpoint (queried by company name) for everything else / as fallback.
//
// The sentiment is shown and LOGGED with each prediction so its value can be
// measured (prediction-log → newsValue). It does NOT change the probabilities
// until it has shown it carries information. Not investment advice.

import { quote } from '../market-data.mjs';
import { chat } from '../ling-client.mjs';
import { extractJson } from './llm-json.mjs';
import { badRequest } from '../util.mjs';

const SEARCH = 'https://query2.finance.yahoo.com/v1/finance/search';
const UA = 'Mozilla/5.0 (AutoClaw Trading Research; read-only)';
const GENERIC = new Set(['limited', 'ltd', 'the', 'and', 'of', 'india', 'company', 'corporation', 'co', 'inc', 'industries', 'services', 'consultancy', 'enterprises', 'holdings']);
const GNEWS = 'https://news.google.com/rss/search';

// NSE tickers whose headlines use a different short name.
export const ALIASES = {
  SBIN: 'SBI', BHARTIARTL: 'Airtel', 'M&M': 'Mahindra', HINDUNILVR: 'HUL', KOTAKBANK: 'Kotak Mahindra Bank',
  BAJFINANCE: 'Bajaj Finance', ASIANPAINT: 'Asian Paints', ULTRACEMCO: 'UltraTech', NESTLEIND: 'Nestle India',
  HEROMOTOCO: 'Hero MotoCorp', EICHERMOT: 'Eicher', TATAMOTORS: 'Tata Motors', TATASTEEL: 'Tata Steel',
  POWERGRID: 'Power Grid', ADANIENT: 'Adani Enterprises', ADANIPORTS: 'Adani Ports', SUNPHARMA: 'Sun Pharma',
  DRREDDY: "Dr Reddy's", APOLLOHOSP: 'Apollo Hospitals', BAJAJFINSV: 'Bajaj Finserv', INDUSINDBK: 'IndusInd',
};
// Headline patterns for aliased names (whole phrase; a few need variants).
const ALIAS_MATCH = {
  SBIN: /\bSBI\b|State Bank of India/i,
  KOTAKBANK: /Kotak (Mahindra )?Bank/i,
  HINDUNILVR: /\bHUL\b|Hindustan Unilever/i,
  'M&M': /\bM&M\b|Mahindra & Mahindra|Mahindra and Mahindra/i,
};
const phrase = (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
// Quote pages / weekly "outlook" listings aren't news.
const JUNK = /stock price|share price( -|$)|outlook for the week|quote|live updates|price today|stock quote/i;
const cache = new Map(); // symbol -> { at, value }

const decode = (t) => String(t || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Parse Google News RSS items → {title, publisher, providerPublishTime, link}. */
export function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const tag = (n) => decode((it.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1]);
    const publisher = tag('source');
    let title = tag('title');
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    return { title, publisher, providerPublishTime: Math.floor(Date.parse(tag('pubDate')) / 1000) || 0, link: tag('link') };
  });
}

async function googleNews(query) {
  const url = `${GNEWS}?q=${encodeURIComponent(`${query} when:7d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  return res.ok ? parseRss(await res.text()) : [];
}

async function yahooNews(query) {
  const res = await fetch(`${SEARCH}?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=15`, { headers: { 'User-Agent': UA } });
  return res.ok ? (await res.json()).news || [] : [];
}
const TTL_MS = 10 * 60_000;

/** Distinctive words from a company name ("Tata Consultancy Services Limited" → ["tata"]). */
export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9& ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
}

/**
 * Keep headlines that mention the company (first distinctive name word, or
 * the ticker as a whole word), are recent, and aren't quote-page listings.
 */
export function relevantHeadlines(items, tokens, { maxAgeDays = 7, now = Date.now(), ticker = '', match = null } = {}) {
  const first = match ? null : tokens[0];
  const tick = match || (ticker ? new RegExp(`\\b${ticker.replace(/[^A-Za-z0-9&]/g, '')}\\b`, 'i') : null);
  const seen = new Set();
  return items
    .filter((n) => {
      const t = String(n.title || '');
      const fresh = now - (n.providerPublishTime || 0) * 1000 <= maxAgeDays * 86400_000;
      const mentions = (first && t.toLowerCase().includes(first)) || (tick && tick.test(t));
      const key = t.toLowerCase().slice(0, 60);
      if (!fresh || !mentions || JUNK.test(t) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.providerPublishTime - a.providerPublishTime);
}

const EVENT_WORDS = [
  ['results', /\b(q[1-4]\s*(fy)?\d*\s*)?results?\b|earnings|quarterly numbers/i],
  ['dividend', /dividend|record date|bonus issue|stock split|buyback/i],
  ['corporate action', /\bipo\b|merger|demerger|acquisition|stake sale|block deal|open offer/i],
  ['rating change', /upgrade|downgrade|target price|rating/i],
  ['policy / regulatory', /\bsebi\b|\brbi\b|penalty|probe|tax demand|ban\b/i],
];

/** Event types mentioned in recent headlines — these usually mean bigger moves. */
/** Market-wide roundups ("Top stocks to watch: TCS, Tata Steel, Reliance…") aren't company events. */
export const isRoundup = (title) => /stocks to (watch|buy)|stock picks|top (stocks|gainers|losers)|market (live|wrap)|sensex|nifty/i.test(title) || (String(title).match(/,/g) || []).length >= 2;

export function detectEvents(headlines) {
  const found = new Set();
  for (const h of headlines) {
    if (isRoundup(h.title)) continue;
    for (const [name, re] of EVENT_WORDS) if (re.test(h.title)) found.add(name);
  }
  return [...found];
}

/**
 * Headlines + (if the key is set) a factual Ling brief with sentiment in [-1, 1].
 * @returns {Promise<{symbol, company, headlines, brief:string|null, sentiment:number|null, note?:string}>}
 */
export async function newsBrief(symbol, { useLlm = true } = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) throw badRequest('symbol is required, e.g. HDFCBANK.NS');
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS && (hit.value.brief || !useLlm)) return hit.value;

  const q = await quote(sym);
  const company = q.name || sym;
  const tokens = nameTokens(company);
  const ticker = String(q.symbol || sym).replace(/\.(NS|BO)$/i, '');
  const indian = /\.(NS|BO)$/i.test(q.symbol || sym);
  let items = [];
  const alias = ALIASES[ticker.toUpperCase()];
  try {
    items = indian ? await googleNews(`${alias || ticker} share`) : [];
  } catch {
    items = [];
  }
  if (!items.length) {
    try {
      items = await yahooNews(tokens.slice(0, 2).join(' ') || company);
    } catch {
      items = [];
    }
  }
  // Aliased names match on their full phrase (e.g. "Kotak Mahindra Bank", not any "Kotak").
  const match = alias ? ALIAS_MATCH[ticker.toUpperCase()] || phrase(alias) : null;
  const headlines = relevantHeadlines(items, tokens, { ticker, match }).slice(0, 8).map((n) => ({
    title: n.title,
    publisher: n.publisher,
    time: new Date((n.providerPublishTime || 0) * 1000).toISOString(),
    link: n.link,
  }));

  const out = { symbol: q.symbol || sym, company, headlines, brief: null, sentiment: null, events: detectEvents(headlines) };
  if (!headlines.length) {
    out.note = 'No recent company-specific headlines found in the free news feed.';
  } else if (useLlm) {
    try {
      const raw = await chat(
        [
          {
            role: 'system',
            content:
              'You summarise news headlines factually for a research dashboard. Do not predict prices or recommend trades. ' +
              'Reply ONLY with JSON: {"brief":"2-3 factual sentences","sentiment":number from -1 (clearly negative for the company) to 1 (clearly positive), 0 if mixed/neutral}',
          },
          { role: 'user', content: `Company: ${company}\nHeadlines (newest first):\n${headlines.map((h) => `- ${h.title} (${h.publisher}, ${h.time.slice(0, 10)})`).join('\n')}` },
        ],
        { temperature: 0.1, timeoutMs: 45_000, jsonKeys: ['sentiment'] },
      );
      const j = extractJson(raw, (o) => 'sentiment' in o || 'brief' in o);
      if (j) {
        out.brief = String(j.brief || '').slice(0, 600);
        const sNum = Number(j.sentiment);
        out.sentiment = Number.isFinite(sNum) ? Math.max(-1, Math.min(1, sNum)) : null;
      }
    } catch (err) {
      out.note = /OPENROUTER_API_KEY/.test(err.message) ? 'Brief needs OPENROUTER_API_KEY; showing headlines only.' : `Brief unavailable: ${err.message.slice(0, 100)}`;
    }
  }
  cache.set(sym, { at: Date.now(), value: out });
  return out;
}
