const CAMPAIGNS = [
  { id: 'frontend', title: 'Frontend & web development', keywords: ['frontend developer', 'web developer', 'React developer'] },
  { id: 'backend', title: 'Backend & API development', keywords: ['backend developer', 'Node.js developer', 'API developer'] },
  { id: 'mobile', title: 'Mobile app development', keywords: ['mobile app developer', 'Flutter developer', 'React Native developer'] },
  { id: 'shopify', title: 'Shopify & e-commerce', keywords: ['Shopify developer', 'Shopify store', 'ecommerce website'] },
  { id: 'design', title: 'UI/UX & product design', keywords: ['UI UX designer', 'Figma designer', 'app design'] },
  { id: 'seo', title: 'SEO & technical SEO', keywords: ['SEO', 'technical SEO', 'SEO expert'] },
  { id: 'paid_ads', title: 'Google Ads & PPC', keywords: ['Google Ads', 'PPC marketing', 'paid ads campaign'] },
  { id: 'marketing', title: 'Social, content & email marketing', keywords: ['social media marketing', 'content marketing', 'email marketing'] },
];

const BASE_URL = 'https://www.freelancer.com/api/projects/0.1/projects/active/';
const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeProject(project, matchedCampaign, keyword) {
  const submitted = Number(project.time_submitted);
  const min = Number(project.budget?.minimum);
  const max = Number(project.budget?.maximum);
  const rate = Number(project.currency?.exchange_rate);
  const code = String(project.currency?.code || '').toUpperCase();
  const bidAverage = Number(project.bid_stats?.bid_avg);
  return {
    id: String(project.id),
    title: String(project.title || ''),
    postedAt: Number.isFinite(submitted) ? new Date(submitted * 1000).toISOString() : '',
    postedAtSeconds: Number.isFinite(submitted) ? submitted : 0,
    projectType: String(project.type || ''),
    budgetMin: Number.isFinite(min) ? min : null,
    budgetMax: Number.isFinite(max) ? max : null,
    currency: code,
    budgetOriginal: `${Number.isFinite(min) ? min : '?'} - ${Number.isFinite(max) ? max : '?'} ${code}`.trim(),
    budgetUsdMin: Number.isFinite(min) && Number.isFinite(rate) ? Math.round(min * rate) : null,
    budgetUsdMax: Number.isFinite(max) && Number.isFinite(rate) ? Math.round(max * rate) : null,
    averageBid: Number.isFinite(bidAverage) && Number.isFinite(rate) ? Math.round(bidAverage * rate) : null,
    bidCount: Number(project.bid_stats?.bid_count) || 0,
    language: String(project.language || ''),
    url: project.seo_url ? `https://www.freelancer.com/projects/${project.seo_url}` : `https://www.freelancer.com/projects/${project.id}`,
    description: String(project.description || '').slice(0, 5000),
    campaigns: [matchedCampaign],
    matchedKeywords: [keyword],
  };
}

async function fetchPage(keyword, offset, onRetry = () => {}) {
  const url = new URL(BASE_URL);
  url.search = new URLSearchParams({
    query: keyword,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    compact: 'true',
    full_description: 'true',
  });

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : Math.min(10_000 * (2 ** attempt), 60_000);
        await response.arrayBuffer().catch(() => {});
        onRetry({ keyword, attempt: attempt + 1, waitSeconds: Math.ceil(waitMs / 1000) });
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new Error(`Freelancer.com HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }
      const body = await response.json();
      const projects = body?.result?.projects;
      if (!Array.isArray(projects)) throw new Error('Freelancer.com response did not include a projects list.');
      return projects;
    } catch (error) {
      if (attempt >= 3 || /Freelancer\.com HTTP 4(?!29)\d/.test(error.message)) throw error;
      await sleep(Math.min(2000 * (2 ** attempt), 15_000));
    }
  }
  return [];
}

async function searchFreelancer(campaignIds, onProgress = () => {}) {
  const selected = CAMPAIGNS.filter(campaign => campaignIds.includes(campaign.id));
  if (!selected.length) throw new Error('Choose at least one Freelancer.com campaign.');
  const cutoff = Date.now() - WINDOW_MS;
  const projects = new Map();
  const log = [];
  let completedSearches = 0;
  const totalSearches = selected.reduce((sum, item) => sum + item.keywords.length, 0);

  searchLoop: for (const campaign of selected) {
    for (const keyword of campaign.keywords) {
      let pages = 0;
      let fetched = 0;
      let stopped = 'max pages';
      let error = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        try {
          const items = await fetchPage(keyword, page * PAGE_SIZE, retry => onProgress({
            stage: `Rate limited · retrying ${retry.keyword} in ${retry.waitSeconds}s`,
            processed: completedSearches,
            total: totalSearches,
          }));
          pages++;
          fetched += items.length;
          if (!items.length) { stopped = 'no more results'; break; }
          let addedOnPage = 0;
          let oldestOnPage = Infinity;
          for (const item of items) {
            const submitted = Number(item.time_submitted) * 1000;
            if (!item.id || !Number.isFinite(submitted)) continue;
            oldestOnPage = Math.min(oldestOnPage, submitted);
            if (submitted < cutoff) continue;
            const normalized = normalizeProject(item, campaign.title, keyword);
            const existing = projects.get(normalized.id);
            if (!existing) {
              projects.set(normalized.id, normalized);
              addedOnPage++;
            } else {
              if (!existing.campaigns.includes(campaign.title)) existing.campaigns.push(campaign.title);
              if (!existing.matchedKeywords.includes(keyword)) existing.matchedKeywords.push(keyword);
            }
          }
          if (oldestOnPage < cutoff) { stopped = 'reached projects older than 3 days'; break; }
          if (page > 0 && addedOnPage === 0) { stopped = 'page had no new projects'; break; }
          if (items.length < PAGE_SIZE) { stopped = 'end of results'; break; }
          if (page < MAX_PAGES - 1) await sleep(1500);
        } catch (caught) {
          error = caught.message;
          stopped = 'request failed';
          break;
        }
      }
      completedSearches++;
      log.push({ campaign: campaign.id, keyword, pages, fetched, inWindow: [...projects.values()].filter(p => p.matchedKeywords.includes(keyword)).length, stopped, error });
      onProgress({ stage: 'Searching Freelancer.com', processed: completedSearches, total: totalSearches });
      if (/HTTP 429/.test(error || '')) break searchLoop;
      await sleep(800);
    }
  }

  return {
    projects: [...projects.values()].sort((a, b) => b.postedAtSeconds - a.postedAtSeconds),
    log,
    searchErrors: log.filter(row => row.error).length,
  };
}

module.exports = { CAMPAIGNS, searchFreelancer };
