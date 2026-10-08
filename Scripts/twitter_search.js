const ROLES = {
  shopify_developer: {
    title: 'Shopify developer',
    groups: ['"Shopify developer" OR "Shopify expert" OR "Shopify app developer" OR "Shopify freelancer" OR "Shopify store developer" OR "Shopify website developer"'],
  },
  backend_developer: {
    title: 'Backend developer',
    groups: ['"backend developer" OR "back end developer" OR "backend engineer" OR "API developer" OR "Node.js developer" OR "Python backend developer"'],
  },
  app_developer: {
    title: 'App developer',
    groups: ['"app developer" OR "mobile app developer" OR "iOS developer" OR "Android developer" OR "React Native developer" OR "Flutter developer" OR "cross-platform app developer"'],
  },
  ui_ux_designer_developer: {
    title: 'UI/UX designer or developer',
    groups: ['"UI/UX designer" OR "UI UX designer" OR "UX designer" OR "UI designer" OR "product designer" OR "UI developer" OR "UX developer" OR "Figma designer"'],
  },
  python_node_flutter_developer: {
    title: 'Python, Node.js, React Native, Next.js or Flutter',
    groups: [
      '"Python developer" OR "Python dev" OR "Python engineer" OR "Django developer" OR "Django expert" OR "FastAPI developer" OR "Flask developer"',
      '"Node.js developer" OR "NodeJS developer" OR "Node dev" OR "Express.js developer" OR "NestJS developer" OR "JavaScript developer" OR "TypeScript developer" OR "MERN stack developer"',
      '"React developer" OR "ReactJS developer" OR "React Native developer" OR "React Native dev" OR "Next.js developer" OR "NextJS developer" OR "Next.js engineer" OR "frontend developer"',
      '"Flutter developer" OR "Flutter dev" OR "Flutter engineer" OR "mobile app developer" OR "cross-platform app developer" OR "Android app developer" OR "iOS app developer"',
    ],
  },
};

const INTENT = '("looking for" OR "need a" OR "need an" OR "seeking a" OR "looking to hire" OR "hiring a")';
const EXCLUDE = ' -"looking to connect" -"#connect" -"@grok" -"join our team" -"for hire" -"hire me" -"open to work" -"available for" -"#hiring" -"full-time" -"full time" -"internship" -is:retweet lang:en';
const BASE_URL = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
const MAX_PAGES = 3;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getPage(apiKey, query, cursor) {
  const url = new URL(BASE_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('queryType', 'Top');
  if (cursor) url.searchParams.set('cursor', cursor);
  for (let attempt = 0; attempt <= 3; attempt++) {
    const response = await fetch(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : 10_000 * (2 ** attempt);
      await response.arrayBuffer().catch(() => {});
      await sleep(waitMs);
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      throw new Error(`TwitterAPI.io HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
  }
  throw new Error('TwitterAPI.io retries exhausted.');
}

async function searchGroup(apiKey, query) {
  const tweets = new Map();
  const pages = [];
  let cursor = null;
  let error = null;
  try {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const page = await getPage(apiKey, query, cursor);
      if (!Array.isArray(page?.tweets)) throw new Error('TwitterAPI.io response did not include tweets.');
      pages.push(page);
      for (const tweet of page.tweets) {
        if (tweet?.id) tweets.set(String(tweet.id), {
          id: String(tweet.id),
          createdAt: String(tweet.createdAt || ''),
          user: String(tweet.author?.userName || ''),
          text: String(tweet.text || '').replace(/\s+/g, ' ').trim(),
          link: `https://x.com/${tweet.author?.userName || 'i'}/status/${tweet.id}`,
        });
      }
      const next = String(page.next_cursor || '');
      if (!page.tweets.length || !next || next === cursor) break;
      cursor = next;
      if (pageNumber < MAX_PAGES) await sleep(1000);
    }
  } catch (caught) { error = caught.message; }
  return { tweets: [...tweets.values()], pages, error };
}

async function searchTwitter(roleId, apiKey, onProgress = () => {}) {
  const role = ROLES[roleId];
  if (!role) throw new Error('Unknown X search role.');
  if (!apiKey) throw new Error('TWITTER_API_KEY is missing.');
  const since = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);
  const queries = role.groups.map(group => `${INTENT} (${group})${EXCLUDE} since_time:${since}`);
  const allTweets = new Map();
  const log = [];
  for (let index = 0; index < queries.length; index++) {
    const result = await searchGroup(apiKey, queries[index]);
    for (const tweet of result.tweets) allTweets.set(tweet.id, tweet);
    log.push({ group: index + 1, query: queries[index], pages: result.pages.length, count: result.tweets.length, error: result.error });
    onProgress({ stage: 'Searching X / Twitter', processed: index + 1, total: queries.length });
    if (/HTTP 429/.test(result.error || '')) break;
    if (index < queries.length - 1) await sleep(2000);
  }
  return {
    tweets: [...allTweets.values()],
    log,
    searchErrors: log.filter(item => item.error).length,
  };
}

module.exports = { ROLES, searchTwitter };
