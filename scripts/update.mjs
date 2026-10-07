// Intelligence Engine: India desk updater.
// Runs on a schedule on GitHub Actions. Reads RSS feeds from six outlets on five continents,
// sends new headlines to Claude for sector tagging, India implications and
// cross-outlet matching, and saves the results to data/india.json for the website.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REGION = "India";
const SCHEMA = 4;                              // v4: follow-ups merge into one developing story                              // bump to re-analyse everything under new rules
const OUTLET_INFO = {
  bbc:        { name: "BBC News",     region: "Europe" },
  guardian:   { name: "The Guardian", region: "Europe" },
  npr:        { name: "NPR",          region: "North America" },
  aljazeera:  { name: "Al Jazeera",   region: "Asia" },
  mercopress: { name: "MercoPress",   region: "South America" },
  abc:        { name: "ABC News",     region: "Australia" },
  thehindu:   { name: "The Hindu",    region: "India" },
  mint:       { name: "Mint",         region: "India" }
};
const OUTLETS = Object.fromEntries(Object.entries(OUTLET_INFO).map(([id, o]) => [id, o.name]));
const SINCE = "2026-10-02";                    // ignore stories published before this date
const GLOBAL_FEEDS = [
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/world/asia/india/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/world/asia/rss.xml" },
  { src: "guardian", url: "https://www.theguardian.com/world/rss" },
  { src: "guardian", url: "https://www.theguardian.com/world/india/rss" },
  { src: "guardian", url: "https://www.theguardian.com/uk/business/rss" },
  { src: "guardian", url: "https://www.theguardian.com/uk/technology/rss" },
  { src: "guardian", url: "https://www.theguardian.com/environment/rss" },
  { src: "guardian", url: "https://www.theguardian.com/world/middleeast/rss" },
  { src: "guardian", url: "https://www.theguardian.com/global-development/rss" },
  { src: "npr", url: "https://feeds.npr.org/1004/rss.xml" },
  { src: "npr", url: "https://feeds.npr.org/1006/rss.xml" },
  { src: "npr", url: "https://feeds.npr.org/1017/rss.xml" },
  { src: "npr", url: "https://feeds.npr.org/1019/rss.xml" },
  { src: "aljazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { src: "mercopress", url: "https://en.mercopress.com/rss" },
  { src: "mercopress", url: "https://en.mercopress.com/rss/energy" },
  { src: "mercopress", url: "https://en.mercopress.com/rss/agriculture" },
  { src: "abc", url: "https://www.abc.net.au/news/feed/10719986/rss.xml" },
  { src: "abc", url: "https://www.abc.net.au/news/feed/104217382/rss.xml" },
  { src: "abc", url: "https://www.abc.net.au/news/feed/104217374/rss.xml" }
];
const INDIA_FEEDS = [
  { src: "thehindu", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
  { src: "thehindu", url: "https://www.thehindu.com/business/feeder/default.rss" },
  { src: "thehindu", url: "https://www.thehindu.com/business/Economy/feeder/default.rss" },
  { src: "thehindu", url: "https://www.thehindu.com/business/Industry/feeder/default.rss" },
  { src: "thehindu", url: "https://www.thehindu.com/business/agri-business/feeder/default.rss" },
  { src: "thehindu", url: "https://www.thehindu.com/sci-tech/technology/feeder/default.rss" },
  { src: "mint", url: "https://www.livemint.com/rss/news" },
  { src: "mint", url: "https://www.livemint.com/rss/economy" },
  { src: "mint", url: "https://www.livemint.com/rss/politics" },
  { src: "mint", url: "https://www.livemint.com/rss/industry" },
  { src: "mint", url: "https://www.livemint.com/rss/companies" },
  { src: "mint", url: "https://www.livemint.com/rss/technology" }
];
const DESKS = [
  { id: "global",   mode: "global",   feeds: GLOBAL_FEEDS, data: "data/india.json",          seen: "data/seen.json",          rejected: "data/rejected.json" },
  { id: "domestic", mode: "domestic", feeds: INDIA_FEEDS,  data: "data/india-domestic.json", seen: "data/seen-domestic.json", rejected: "data/rejected-domestic.json" }
];
const MODELS = [process.env.CLAUDE_MODEL || "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];
const SECTORS = [
  { id: "energy",        name: "Energy" },
  { id: "logistics",     name: "Logistics & Shipping" },
  { id: "economy",       name: "Economy & Trade" },
  { id: "technology",    name: "Technology" },
  { id: "manufacturing", name: "Manufacturing" },
  { id: "environment",   name: "Environment & Climate" },
  { id: "agriculture",   name: "Agriculture & Food" },
  { id: "governance",    name: "Policy & Governance" }
];
const MAX_REJECTED = 150;                      // audit trail of what the filter discarded, per desk
const BATCH = 15;              // headlines per Claude request
const MAX_NEW_PER_RUN = 150;   // the rest wait for the next run
const MATCH_WINDOW_DAYS = 4;   // how far back to look for the same event
const MAX_PER_SECTOR = 40;
const MAX_SEEN = 3000;

/* ---------- helpers ---------- */
async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return fallback; }
}
function decode(s) {
  return String(s || "")
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&").trim();
}
function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1].trim()) : "";
}
function plain(s) { return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 400); }
// Skip formats that duplicate an article or aren't reporting: videos, live blogs, opinion, sport, podcasts.
function skip(title, link) {
  if (/^(watch|listen|video)\s*:/i.test(title)) return true;
  if (/– as it happened$|- as it happened$/i.test(title)) return true;
  // newsletters, briefings, podcasts and round-ups summarise other reports rather than reporting news
  if (/^((monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|evening|weekend|first edition|business today)\b[^:]{0,20})?\s*briefing\s*:/i.test(title)) return true;
  if (/^(first edition|the long read|today in focus|business live|newsletter)\b|\b(podcast|quiz|in (\d+ )?(photos|pictures))\b|[–-] live$/i.test(title)) return true;
  if (/\/series\/|\/info\/|\/newsletters?\//.test(link)) return true;
  // single-stock and market-ticker items (common on business sites) edge towards stock tips
  if (/\b(share price|shares (jump|surge|fall|slump|rise|tank|rally)|stocks? to (buy|watch)|buy or sell|target price|sensex|nifty|stock market today|ipo (gmp|allotment|subscription)|q[1-4] results?:)\b/i.test(title)) return true;
  if (/\/market\/stock-market-news\/|\/market\/live-blog\/|\/astrology\/|\/horoscope/.test(link)) return true;
  return /\/sport\/|\/sports\/|\/live\/|\/liveblog\/|\/videos?\/|\/program\/|\/gallery\/|\/podcasts?\/|\/opinions?\/|\/commentisfree\/|\/audio\/|\/football\/|\/lifeandstyle\/|\/culture\/|\/tv-and-radio\/|\/music\/|\/film\/|\/books\//.test(link);
}
// Publisher-supplied thumbnail from the feed item (linked, not copied). Prefers the widest rendition.
function unescapeHtml(s) { return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&"); }
function attr(a, name) { const m = new RegExp(`\\b${name}=["']([^"']+)["']`).exec(a); return m ? m[1] : ""; }
export function imageOf(block) {
  const cands = [];
  for (const m of block.matchAll(/<media:(?:content|thumbnail)\b([^>]*)>/g)) {
    const a = m[1], url = attr(a, "url"), medium = attr(a, "medium"), type = attr(a, "type");
    if (!url || (medium && medium !== "image") || (type && !/^image\//.test(type))) continue;
    cands.push({ url, w: +(attr(a, "width") || 0) });
  }
  for (const m of block.matchAll(/<enclosure\b([^>]*)>/g)) {
    const url = attr(m[1], "url"), type = attr(m[1], "type");
    if (url && /^image\//.test(type)) cands.push({ url, w: 0 });
  }
  if (!cands.length) {
    const img = /<img[^>]+src=["']([^"']+)["']/i.exec(unescapeHtml(block.replace(/<!\[CDATA\[|\]\]>/g, "")));
    if (img) cands.push({ url: img[1], w: 0 });
  }
  cands.sort((x, y) => y.w - x.w);
  let u = cands[0] && unescapeHtml(cands[0].url);
  if (!u) return null;
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https:\/\//.test(u)) return null;
  const out = { image: u };
  // BBC's image service serves the same picture at larger widths; the site falls back to the original if this fails.
  const big = u.replace(/(ichef\.bbci\.co\.uk\/(?:ace|news)\/(?:standard|ws)\/)\d+\//, "$1976/");
  if (big !== u) out.imageLarge = big;
  return out;
}
function cleanUrl(u) { try { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); } catch { return u; } }
function idFor(url) { let h = 0; for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "s" + h.toString(36); }

export function parseRss(xml, src) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = plain(tag(b, "title")), link = cleanUrl(tag(b, "link")), summary = plain(tag(b, "description"));
    const pub = Date.parse(tag(b, "pubDate") || tag(b, "dc:date"));
    if (!title || !link || skip(title, link)) continue;
    items.push({ src, headline: title, url: link, summary, date: isNaN(pub) ? null : new Date(pub).toISOString(), ...(imageOf(b) || {}) });
  }
  return items;
}

let feedHealth = {};   // outlet -> { feedsOk, feedsFailed, items }
async function fetchFeeds(FEEDS) {
  const all = new Map();
  for (const { src, url } of FEEDS) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "intelligence-engine/1.0 (+github actions)" } });
      const h = feedHealth[src] ||= { feedsOk: 0, feedsFailed: 0, items: 0 };
      if (!res.ok) { console.warn(`Feed ${url} returned ${res.status}`); h.feedsFailed++; continue; }
      const items = parseRss(await res.text(), src);
      h.feedsOk++; h.items += items.length;
      for (const it of items) if (!all.has(it.url)) all.set(it.url, it);
    } catch (e) { console.warn(`Feed ${url} failed: ${e.message}`); (feedHealth[src] ||= { feedsOk: 0, feedsFailed: 0, items: 0 }).feedsFailed++; }
  }
  return [...all.values()];
}

/* ---------- Claude analysis ---------- */
const SAME_EVENT_RULE = `Same story: if an item reports the same story as one of the KNOWN EVENTS below, set "sameAs" to that event's key. If it reports the same story as an EARLIER item in this list, set "sameAs" to "item:<id>". The same story includes follow-ups, updates, new details, reactions and investigations about the SAME incident, protest, conflict, crisis or announcement (for example three reports on the same protest movement, or a later update on the same war). It is a DIFFERENT story when a different actor takes a separate decision or action, even on the same topic (for example "US pressures Europe to release reserves" and "G7 agrees to release reserves" are two stories). Otherwise "sameAs" is null.`;

function buildPrompt(batch, recent, mode) {
  const sectors = SECTORS.map(s => `- ${s.id}: ${s.name}`).join("\n");
  const items = batch.map((s, i) => ({ id: i, outlet: OUTLETS[s.src], headline: s.headline, summary: s.summary }));
  const known = recent.map(e => ({ key: e.id, headline: e.headline }));
  const shape = `[{"id":0,"relevant":true,"sector":"energy","relevance":"high","why":"...","implications":["...","..."],"sameAs":null}]`;
  if (mode === "domestic") return `You are the analysis desk of an intelligence product that explains what developments INSIDE ${REGION} mean for people and businesses in ${REGION}.

Sectors:
${sectors}

For each news item below from an Indian outlet, decide whether it is a development of NATIONAL significance in one of these sectors. If it is, choose the ONE sector it fits best and explain what it means.

Rules:
1. Use only the headline and summary as facts. Do not invent numbers, names or events.
2. "why" is one sentence on why this matters for ${REGION} as a whole. Implications are concrete near-term effects on households, workers, farmers, businesses, prices, jobs, loans, taxes, supply or public services. One plain sentence each, under 25 words.
3. Never discuss securities: no stocks, share prices, market moves, companies that benefit, or investment actions.
4. Use cautious wording ("may", "could", "likely") for anything uncertain.
5. Be strict. Keep national policy, regulation, budgets and taxes, RBI and banking, inflation and jobs data, infrastructure, energy, industry and manufacturing, agriculture and food supply, technology and telecom policy, environment and climate events with wide impact, and major governance developments. Mark relevant=false for crime, accidents, court cases about individuals, celebrity, entertainment, sport, religion, city- or state-level stories without national impact, party political sparring, single-company results or deals that do not affect a whole sector, and stock-market commentary. When unsure, choose false.
6. relevance: "high" = direct, material effect on many people or a whole sector within weeks; "medium" = clear but modest or narrower.
7. ${SAME_EVENT_RULE}

KNOWN EVENTS:
${JSON.stringify(known)}

Items:
${JSON.stringify(items)}

Return ONLY a JSON array, one object per item:
${shape}
For relevant=false return {"id":N,"relevant":false,"reason":"why it is not of national significance, under 15 words","sameAs":null}. Give 2 or 3 implications when relevant.`;

  return `You are the analysis desk of an intelligence product that explains how world news affects ${REGION}.

Sectors:
${sectors}

For each news item below, decide whether it plausibly affects ${REGION}. If it does, choose the ONE sector it affects most and explain the effect.

Rules:
1. Use only the headline and summary as facts. Do not invent numbers, names or events.
2. Implications are near-term effects on ${REGION}: prices, supply, trade, jobs, travel, citizens abroad, policy or security. One plain sentence each, under 25 words.
3. Describe effects on the economy and society, never on securities: no stocks, no companies that benefit, no investment actions.
4. Use cautious wording ("may", "could", "likely") for anything uncertain.
5. Be strict. Mark relevant=false unless the item itself describes something with a clear path to ${REGION}: a global price, supply or trade shift, a policy by a major economy, a regional conflict on India's trade or energy routes, or events in or about ${REGION}. Judge by what the HEADLINE is about. A story framed around another country's domestic prices, politics, services or crime is NOT relevant, even if its summary mentions a global cause (for example "UK diesel price hits record high" is false); the global cause gets its own story. Elections, leadership contests and changes of government in other countries are NOT relevant unless the item itself mentions a trade, tariff, energy, sanctions or foreign-policy shift. When unsure, choose false.
6. relevance: "high" = direct, material effect within weeks; "medium" = clear but modest or indirect.
7. ${SAME_EVENT_RULE}

KNOWN EVENTS:
${JSON.stringify(known)}

Items:
${JSON.stringify(items)}

Return ONLY a JSON array, one object per item:
${shape}
For relevant=false return {"id":N,"relevant":false,"reason":"why it does not reach ${REGION}, under 15 words","sameAs":null}. Give 2 or 3 implications when relevant.`;
}

async function callClaude(prompt) {
  let lastErr;
  for (const model of MODELS) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (body.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const i = text.indexOf("["), j = text.lastIndexOf("]");
      if (i < 0 || j < i) throw new Error("Claude reply had no JSON array");
      return JSON.parse(text.slice(i, j + 1));
    }
    lastErr = new Error(`Claude API ${res.status}: ${body?.error?.message || "unknown error"}`);
    // Try the fallback model only when this model name isn't available.
    if (!(res.status === 404 || (res.status === 400 && /model/i.test(body?.error?.message || "")))) break;
    console.warn(`Model ${model} unavailable, trying fallback`);
  }
  throw lastErr;
}

/* ---------- main ---------- */
export async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY secret is missing."); process.exit(1); }
  await fs.mkdir("data", { recursive: true });
  let deskFailed = false;
  for (const desk of DESKS) {
    console.log(`\n=== ${desk.id} desk ===`);
    const r = await runDesk(desk);
    if (r.failures && !r.added && !r.merged && r.analysed) deskFailed = true;
  }
  if (deskFailed) process.exit(1); // surface a desk whose analysis failed entirely in the Actions tab
}

async function runDesk(desk) {
  feedHealth = {};
  let data = await readJson(desk.data, null);
  let seen = new Set(await readJson(desk.seen, []));
  if (!data || data.schema !== SCHEMA) {
    console.log("Starting fresh under the current rules (schema " + SCHEMA + ")");
    data = null; seen = new Set();
  }
  data = data || { schema: SCHEMA, region: REGION, since: SINCE, updatedAt: null, sectors: [] };
  data.schema = SCHEMA; data.desk = desk.id; data.mode = desk.mode;
  const deskOutlets = [...new Set(desk.feeds.map(f => f.src))];
  data.sources = deskOutlets.map(id => ({ id, name: OUTLET_INFO[id].name, region: OUTLET_INFO[id].region }));
  data.source = Object.values(OUTLETS).join(" & ");
  const byId = Object.fromEntries((data.sectors || []).map(s => [s.id, s]));
  data.sectors = SECTORS.map(s => ({ ...s, items: byId[s.id]?.items || [] }));

  const allEvents = () => data.sectors.flatMap(s => s.items);
  const findEvent = key => allEvents().find(e => e.id === key);
  const sinceMs = Date.parse(SINCE);
  const fetched = await fetchFeeds(desk.feeds);
  // Backfill images onto stories already on the desk (no re-analysis needed).
  const imgByUrl = new Map(fetched.filter(i => i.image).map(i => [i.url, i]));
  let backfilled = 0;
  for (const sec of data.sectors) for (const ev of sec.items) {
    for (const r of ev.reports || []) { const f = imgByUrl.get(r.url); if (f && !r.image) { r.image = f.image; if (f.imageLarge) r.imageLarge = f.imageLarge; } }
    if (!ev.image) { const r = (ev.reports || []).find(x => x.image); if (r) { ev.image = r.image; if (r.imageLarge) ev.imageLarge = r.imageLarge; backfilled++; } }
  }
  if (backfilled) console.log(`Added images to ${backfilled} existing stories`);
  const fresh = fetched
    .filter(it => !it.date || Date.parse(it.date) >= sinceMs)
    .filter(it => !seen.has(it.url))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))   // take the newest headlines first...
    .slice(0, MAX_NEW_PER_RUN)
    .reverse();                                                    // ...then process them in time order so the first report leads
  console.log(`${fresh.length} new headlines to analyse: ` + deskOutlets.map(k => `${OUTLETS[k]} ${fresh.filter(f => f.src === k).length}`).join(", "));
  console.log("Feed health: " + JSON.stringify(feedHealth));

  const rejected = data.schema === SCHEMA && seen.size ? await readJson(desk.rejected, []) : [];
  let added = 0, merged = 0, failures = 0;
  for (let k = 0; k < fresh.length; k += BATCH) {
    const batch = fresh.slice(k, k + BATCH);
    const cutoff = Date.now() - MATCH_WINDOW_DAYS * 864e5;
    const recent = allEvents().filter(e => !e.date || Date.parse(e.date) >= cutoff).slice(0, 80);
    let results;
    try { results = await callClaude(buildPrompt(batch, recent, desk.mode)); }
    catch (e) { console.error(`Batch failed: ${e.message}`); failures++; continue; } // not marked seen: retried next run
    const placed = {};                                      // batch index -> event it went into
    for (const r of [...results].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))) {
      const s = batch[r?.id]; if (!s) continue;
      if (!r.relevant) {
        rejected.unshift({ source: s.src, headline: s.headline, url: s.url, date: s.date,
          reason: typeof r.reason === "string" ? r.reason.slice(0, 160) : "", checkedAt: new Date().toISOString() });
        continue;
      }
      const report = { source: s.src, headline: s.headline, url: s.url, date: s.date, ...(s.image ? { image: s.image } : {}), ...(s.imageLarge ? { imageLarge: s.imageLarge } : {}) };
      let target = null;
      if (typeof r.sameAs === "string") {
        target = r.sameAs.startsWith("item:") ? placed[+r.sameAs.slice(5)] : findEvent(r.sameAs);
      }
      if (target) {
        if (!target.reports.some(x => x.url === s.url)) target.reports.push(report);
        if (!target.image && s.image) { target.image = s.image; if (s.imageLarge) target.imageLarge = s.imageLarge; }
        if (r.relevance === "high") target.relevance = "high";
        placed[r.id] = target; merged++;
        continue;
      }
      const sector = data.sectors.find(x => x.id === r.sector);
      if (!sector) continue;
      const ev = {
        id: idFor(s.url), headline: s.headline, url: s.url, source: s.src, date: s.date,
        relevance: r.relevance === "high" ? "high" : "medium",
        ...(s.image ? { image: s.image } : {}), ...(s.imageLarge ? { imageLarge: s.imageLarge } : {}),
        why: typeof r.why === "string" ? r.why : "",
        implications: (r.implications || []).filter(x => typeof x === "string").slice(0, 3),
        reports: [report]
      };
      sector.items.push(ev); placed[r.id] = ev; added++;
    }
    batch.forEach(s => seen.add(s.url));
  }

  for (const s of data.sectors) {
    const uniq = new Map(s.items.map(i => [i.id, i]));
    s.items = [...uniq.values()].sort((a, b) => latest(b).localeCompare(latest(a))).slice(0, MAX_PER_SECTOR);
  }
  data.updatedAt = new Date().toISOString();
  data.lastRun = { analysed: fresh.length, added, merged, rejected: fresh.length && !failures ? fresh.length - added - merged : undefined, failedBatches: failures, feeds: feedHealth };

  await fs.writeFile(desk.data, JSON.stringify(data, null, 2) + "\n");
  await fs.writeFile(desk.seen, JSON.stringify([...seen].slice(-MAX_SEEN)) + "\n");
  await fs.writeFile(desk.rejected, JSON.stringify(rejected.slice(0, MAX_REJECTED), null, 2) + "\n");
  console.log(`Added ${added} new events, merged ${merged} reports into existing events. Failed batches: ${failures}.`);
  return { added, merged, failures, analysed: fresh.length };
}
function latest(e) { return (e.reports || []).map(r => r.date || "").sort().pop() || e.date || ""; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
