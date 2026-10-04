// Intelligence Engine: India desk updater.
// Runs every 15 minutes on GitHub Actions. Reads BBC News and Guardian RSS feeds,
// sends new headlines to Claude for sector tagging, India implications and
// cross-outlet matching, and saves the results to data/india.json for the website.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REGION = "India";
const SCHEMA = 2;                              // bump to re-analyse everything under new rules
const OUTLETS = { bbc: "BBC News", guardian: "The Guardian" };
const SINCE = "2026-10-02";                    // ignore stories published before this date
const FEEDS = [
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml" },
  { src: "bbc", url: "https://feeds.bbci.co.uk/news/world/asia/india/rss.xml" },
  { src: "guardian", url: "https://www.theguardian.com/world/rss" },
  { src: "guardian", url: "https://www.theguardian.com/world/india/rss" },
  { src: "guardian", url: "https://www.theguardian.com/uk/business/rss" },
  { src: "guardian", url: "https://www.theguardian.com/uk/technology/rss" },
  { src: "guardian", url: "https://www.theguardian.com/environment/rss" }
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
const DATA_FILE = "data/india.json";
const SEEN_FILE = "data/seen.json";
const BATCH = 10;              // headlines per Claude request
const MAX_NEW_PER_RUN = 80;    // the rest wait for the next run
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
  return /\/sport\/|\/live\/|\/videos?\/|\/commentisfree\/|\/audio\/|\/football\/|\/lifeandstyle\/|\/culture\/|\/tv-and-radio\/|\/music\/|\/film\/|\/books\//.test(link);
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
    items.push({ src, headline: title, url: link, summary, date: isNaN(pub) ? null : new Date(pub).toISOString() });
  }
  return items;
}

async function fetchFeeds() {
  const all = new Map();
  for (const { src, url } of FEEDS) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "intelligence-engine/1.0 (+github actions)" } });
      if (!res.ok) { console.warn(`Feed ${url} returned ${res.status}`); continue; }
      for (const it of parseRss(await res.text(), src)) if (!all.has(it.url)) all.set(it.url, it);
    } catch (e) { console.warn(`Feed ${url} failed: ${e.message}`); }
  }
  return [...all.values()];
}

/* ---------- Claude analysis ---------- */
function buildPrompt(batch, recent) {
  const sectors = SECTORS.map(s => `- ${s.id}: ${s.name}`).join("\n");
  const items = batch.map((s, i) => ({ id: i, outlet: OUTLETS[s.src], headline: s.headline, summary: s.summary }));
  const known = recent.map(e => ({ key: e.id, headline: e.headline }));
  return `You are the analysis desk of an intelligence product that explains how world news affects ${REGION}.

Sectors:
${sectors}

For each news item below, decide whether it plausibly affects ${REGION}. If it does, choose the ONE sector it affects most and explain the effect.

Rules:
1. Use only the headline and summary as facts. Do not invent numbers, names or events.
2. Implications are near-term effects on ${REGION}: prices, supply, trade, jobs, travel, citizens abroad, policy or security. One plain sentence each, under 25 words.
3. Describe effects on the economy and society, never on securities: no stocks, no companies that benefit, no investment actions.
4. Use cautious wording ("may", "could", "likely") for anything uncertain.
5. Be strict. Mark relevant=false unless the item itself describes something with a clear path to ${REGION}: a global price, supply or trade shift, a policy by a major economy, a regional conflict on India's trade or energy routes, or events in or about ${REGION}. Domestic prices, politics, services or crime inside another country are NOT relevant, even when a global trend is behind them. When unsure, choose false.
6. relevance: "high" = direct, material effect within weeks; "medium" = clear but modest or indirect.
7. Same event: if an item reports the same specific event or development as one of the KNOWN EVENTS below, set "sameAs" to that event's key. If it reports the same event as an EARLIER item in this list, set "sameAs" to "item:<id>" of that earlier item. Otherwise "sameAs" is null. Same topic or country is not enough; it must be the same incident, decision or announcement.

KNOWN EVENTS:
${JSON.stringify(known)}

Items:
${JSON.stringify(items)}

Return ONLY a JSON array, one object per item:
[{"id":0,"relevant":true,"sector":"energy","relevance":"high","why":"one sentence on how this reaches ${REGION}","implications":["...","..."],"sameAs":null}]
For relevant=false return {"id":N,"relevant":false,"sameAs":null}. Give 2 or 3 implications when relevant.`;
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

  let data = await readJson(DATA_FILE, null);
  let seen = new Set(await readJson(SEEN_FILE, []));
  if (!data || data.schema !== SCHEMA) {
    console.log("Starting fresh under the current rules (schema " + SCHEMA + ")");
    data = null; seen = new Set();
  }
  data = data || { schema: SCHEMA, region: REGION, since: SINCE, updatedAt: null, sectors: [] };
  data.schema = SCHEMA;
  data.sources = Object.entries(OUTLETS).map(([id, name]) => ({ id, name }));
  data.source = Object.values(OUTLETS).join(" & ");
  const byId = Object.fromEntries((data.sectors || []).map(s => [s.id, s]));
  data.sectors = SECTORS.map(s => ({ ...s, items: byId[s.id]?.items || [] }));

  const allEvents = () => data.sectors.flatMap(s => s.items);
  const findEvent = key => allEvents().find(e => e.id === key);
  const sinceMs = Date.parse(SINCE);
  const fresh = (await fetchFeeds())
    .filter(it => !it.date || Date.parse(it.date) >= sinceMs)
    .filter(it => !seen.has(it.url))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))   // oldest first, so the first report of an event leads
    .slice(0, MAX_NEW_PER_RUN);
  console.log(`${fresh.length} new headlines to analyse (${fresh.filter(f => f.src === "bbc").length} BBC, ${fresh.filter(f => f.src === "guardian").length} Guardian)`);

  let added = 0, merged = 0, failures = 0;
  for (let k = 0; k < fresh.length; k += BATCH) {
    const batch = fresh.slice(k, k + BATCH);
    const cutoff = Date.now() - MATCH_WINDOW_DAYS * 864e5;
    const recent = allEvents().filter(e => !e.date || Date.parse(e.date) >= cutoff).slice(0, 80);
    let results;
    try { results = await callClaude(buildPrompt(batch, recent)); }
    catch (e) { console.error(`Batch failed: ${e.message}`); failures++; continue; } // not marked seen: retried next run
    const placed = {};                                      // batch index -> event it went into
    for (const r of [...results].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))) {
      const s = batch[r?.id]; if (!s || !r.relevant) continue;
      const report = { source: s.src, headline: s.headline, url: s.url, date: s.date };
      let target = null;
      if (typeof r.sameAs === "string") {
        target = r.sameAs.startsWith("item:") ? placed[+r.sameAs.slice(5)] : findEvent(r.sameAs);
      }
      if (target) {
        if (!target.reports.some(x => x.url === s.url)) target.reports.push(report);
        if (r.relevance === "high") target.relevance = "high";
        placed[r.id] = target; merged++;
        continue;
      }
      const sector = data.sectors.find(x => x.id === r.sector);
      if (!sector) continue;
      const ev = {
        id: idFor(s.url), headline: s.headline, url: s.url, source: s.src, date: s.date,
        relevance: r.relevance === "high" ? "high" : "medium",
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
  data.lastRun = { analysed: fresh.length, added, merged, failedBatches: failures };

  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  await fs.writeFile(SEEN_FILE, JSON.stringify([...seen].slice(-MAX_SEEN)) + "\n");
  console.log(`Added ${added} new events, merged ${merged} reports into existing events. Failed batches: ${failures}.`);
  if (failures && !added && !merged && fresh.length) process.exit(1); // surface total failure in the Actions tab
}
function latest(e) { return (e.reports || []).map(r => r.date || "").sort().pop() || e.date || ""; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
