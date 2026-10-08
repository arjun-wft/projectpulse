// freelancer-fetch.mjs  ->  run: node freelancer-fetch.mjs
// Output: freelancer-leads.json + short summary in terminal
import { writeFileSync } from "node:fs";

// ---------- SETTINGS ----------
const DAYS = 3;             // last N days only
const PAGE_SIZE = 50;       // projects per request
const MAX_PAGES = 3;        // max pages per keyword
const MIN_BUDGET_USD = 0;   // e.g. 100 to skip tiny jobs
const DELAY_MS = 1500;      // gap between requests
const OUTPUT_FILE = "freelancer-leads.json";

const SECTIONS = {
  "Frontend Developer": ["frontend developer", "react developer", "next.js developer"],
  "Backend Developer": ["backend developer", "node.js developer", "api developer"],
  "App Developer": ["mobile app developer", "flutter developer", "react native developer"],
  "Shopify Developer": ["shopify developer", "shopify store"],
  "UI/UX Designer": ["ui ux designer", "figma designer", "app design"],
};
// ------------------------------

const BASE = "https://www.freelancer.com/api/projects/0.1/projects/active/";
const cutoffMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(keyword, offset) {
  const url =
    `${BASE}?query=${encodeURIComponent(keyword)}` +
    `&limit=${PAGE_SIZE}&offset=${offset}&compact=true&full_description=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${keyword}" (offset ${offset})`);
  const json = await res.json();
  return json.result?.projects ?? [];
}

function clean(p) {
  const rate = p.currency?.exchange_rate ?? 1;
  const min = p.budget?.minimum ?? 0;
  const max = p.budget?.maximum ?? 0;
  const postedMs = p.time_submitted * 1000;
  return {
    id: p.id,
    title: p.title,
    posted_at: new Date(postedMs).toISOString(),
    hours_ago: Math.round((Date.now() - postedMs) / 3600000),
    type: p.type, // fixed or hourly
    budget_original: `${min} - ${max} ${p.currency?.code ?? ""}`.trim(),
    budget_usd_min: Math.round(min * rate),
    budget_usd_max: Math.round(max * rate),
    bids: p.bid_stats?.bid_count ?? 0,
    avg_bid_usd: Math.round((p.bid_stats?.bid_avg ?? 0) * rate),
    language: p.language,
    url: `https://www.freelancer.com/projects/${p.seo_url}`,
    description: (p.description ?? "").slice(0, 1500),
  };
}

const found = new Map(); // id -> lead (deduped)
const log = [];

for (const [section, keywords] of Object.entries(SECTIONS)) {
  for (const keyword of keywords) {
    let fetched = 0, kept = 0, stopped = "max pages";

    for (let page = 0; page < MAX_PAGES; page++) {
      let items;
      try {
        items = await fetchPage(keyword, page * PAGE_SIZE);
      } catch (err) {
        stopped = `error: ${err.message}`;
        break;
      }
      if (items.length === 0) { stopped = "no more results"; break; }
      fetched += items.length;

      let newOnPage = 0;
      for (const p of items) {
        if (p.time_submitted * 1000 < cutoffMs) continue; // too old
        const lead = clean(p);
        if (lead.budget_usd_max < MIN_BUDGET_USD) continue;

        if (found.has(lead.id)) {
          const ex = found.get(lead.id);
          if (!ex.sections.includes(section)) ex.sections.push(section);
        } else {
          found.set(lead.id, { ...lead, sections: [section], matched_keywords: [] });
          newOnPage++;
        }
        const entry = found.get(lead.id);
        if (!entry.matched_keywords.includes(keyword)) entry.matched_keywords.push(keyword);
        kept++;
      }

      const oldestMs = Math.min(...items.map((p) => p.time_submitted * 1000));
      if (oldestMs < cutoffMs) { stopped = `reached projects older than ${DAYS} days`; break; }
      if (page > 0 && newOnPage === 0 && kept === 0) {
        stopped = "page gave nothing new (offset may be ignored)";
        break;
      }
      await sleep(DELAY_MS);
    }

    log.push({ section, keyword, fetched, kept_in_window: kept, stopped });
    console.log(`[${section}] "${keyword}": fetched ${fetched}, in last ${DAYS} days ${kept} (${stopped})`);
    await sleep(DELAY_MS);
  }
}

const leads = [...found.values()].sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1));

const perSection = {};
for (const l of leads) for (const s of l.sections) perSection[s] = (perSection[s] ?? 0) + 1;

const output = {
  generated_at: new Date().toISOString(),
  window_days: DAYS,
  total_unique_projects: leads.length,
  per_section_count: perSection,
  search_log: log,
  leads,
};

writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
console.log(`\nDone. ${leads.length} unique projects saved to ${OUTPUT_FILE}`);
console.log("Per section:", perSection);