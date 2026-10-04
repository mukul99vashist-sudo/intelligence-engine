// Intelligence Engine: India desk updater.
// Runs every 15 minutes on GitHub Actions. Reads BBC News RSS feeds, sends new
// headlines to Claude for sector tagging and India implications, and saves
// the results to data/india.json, which the website reads.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REGION = "India";
const SOURCE = "BBC News";
const SINCE = "2026-10-02";                    // ignore stories published before this date
const FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://feeds.bbci.co.uk/news/business/rss.xml",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  "https://feeds.bbci.co.uk/news/world/asia/india/rss.xml"
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
const MAX_NEW_PER_RUN = 60;    // the rest wait for the next run
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
function cleanUrl(u) { try { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); } catch { return u; } }
function idFor(url) { let h = 0; for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "s" + h.toString(36); }

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = tag(b, "title"), link = cleanUrl(tag(b, "link")), summary = tag(b, "description");
    const pub = Date.parse(tag(b, "pubDate"));
    if (!title || !link) continue;
    if (/\/sport\/|\/live\//.test(link)) continue;
    items.push({ headline: title, url: link, summary, date: isNaN(pub) ? null : new Date(pub).toISOString() });
  }
  return items;
}

async function fetchFeeds() {
  const all = new Map();
  for (const url of FEEDS) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "intelligence-engine/1.0 (+github actions)" } });
      if (!res.ok) { console.warn(`Feed ${url} returned ${res.status}`); continue; }
      for (const it of parseRss(await res.text())) if (!all.has(it.url)) all.set(it.url, it);
    } catch (e) { console.warn(`Feed ${url} failed: ${e.message}`); }
  }
  return [...all.values()];
}

/* ---------- Claude analysis ---------- */
function buildPrompt(batch) {
  const sectors = SECTORS.map(s => `- ${s.id}: ${s.name}`).join("\n");
  const items = batch.map((s, i) => ({ id: i, headline: s.headline, summary: s.summary }));
  return `You are the analysis desk of an intelligence product that explains how world news affects ${REGION}.

Sectors:
${sectors}

For each BBC News item below, decide whether it plausibly affects ${REGION}. If it does, choose the ONE sector it affects most and explain the effect.

Rules:
1. Use only the headline and summary as facts. Do not invent numbers, names or events.
2. Implications are near-term effects on ${REGION}: prices, supply, trade, jobs, travel, citizens abroad, policy or security. One plain sentence each, under 25 words.
3. Describe effects on the economy and society, never on securities: no stocks, no companies that benefit, no investment actions.
4. Use cautious wording ("may", "could", "likely") for anything uncertain.
5. Mark relevant=false when the link to ${REGION} is weak or speculative. Do not stretch. Crime, celebrity, sport and purely local stories elsewhere are usually not relevant.
6. relevance: "high" = direct, material effect within weeks; "medium" = clear but modest or indirect.

Items:
${JSON.stringify(items)}

Return ONLY a JSON array, one object per item:
[{"id":0,"relevant":true,"sector":"energy","relevance":"high","why":"one sentence on how this reaches ${REGION}","implications":["...","..."]}]
For relevant=false return {"id":N,"relevant":false}. Give 2 or 3 implications when relevant.`;
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

  const data = await readJson(DATA_FILE, null) || {
    region: REGION, source: SOURCE, since: SINCE, updatedAt: null,
    sectors: SECTORS.map(s => ({ ...s, items: [] }))
  };
  // keep sector list in sync with the config above
  const byId = Object.fromEntries((data.sectors || []).map(s => [s.id, s]));
  data.sectors = SECTORS.map(s => ({ ...s, items: byId[s.id]?.items || [] }));
  const seen = new Set(await readJson(SEEN_FILE, []));

  const sinceMs = Date.parse(SINCE);
  const fresh = (await fetchFeeds())
    .filter(it => !it.date || Date.parse(it.date) >= sinceMs)
    .filter(it => !seen.has(it.url))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, MAX_NEW_PER_RUN);
  console.log(`${fresh.length} new headlines to analyse`);

  let added = 0, failures = 0;
  for (let k = 0; k < fresh.length; k += BATCH) {
    const batch = fresh.slice(k, k + BATCH);
    let results;
    try { results = await callClaude(buildPrompt(batch)); }
    catch (e) { console.error(`Batch failed: ${e.message}`); failures++; continue; } // not marked seen: retried next run
    for (const r of results) {
      const s = batch[r?.id]; if (!s) continue;
      const sector = data.sectors.find(x => x.id === r.sector);
      if (r.relevant && sector) {
        sector.items.push({
          id: idFor(s.url), headline: s.headline, url: s.url, date: s.date,
          relevance: r.relevance === "high" ? "high" : "medium",
          why: typeof r.why === "string" ? r.why : "",
          implications: (r.implications || []).filter(x => typeof x === "string").slice(0, 3)
        });
        added++;
      }
    }
    batch.forEach(s => seen.add(s.url));
  }

  for (const s of data.sectors) {
    const uniq = new Map(s.items.map(i => [i.url, i]));
    s.items = [...uniq.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, MAX_PER_SECTOR);
  }
  data.updatedAt = new Date().toISOString();
  data.lastRun = { analysed: fresh.length, added, failedBatches: failures };

  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  await fs.writeFile(SEEN_FILE, JSON.stringify([...seen].slice(-MAX_SEEN)) + "\n");
  console.log(`Added ${added} India-relevant stories. Failed batches: ${failures}.`);
  if (failures && !added && fresh.length) process.exit(1); // surface total failure in the Actions tab
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
