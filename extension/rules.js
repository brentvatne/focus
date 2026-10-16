// @ts-check
// The blocking policy as declarativeNetRequest rules, plus a small evaluator of
// those same rules, so the navigation checks in background.js can't drift from
// what Chrome enforces. Pure: no chrome.* or DOM, so bun test imports it too.

/** Bumped when the messages between the extension and `focus` change shape. */
export const PROTOCOL = 1;

/**
 * @typedef {"on" | "off" | "none"} State
 * @typedef {"reddit" | "youtube" | "x"} Site
 * @typedef {{ state: State, reddit: boolean, allow: string[], feeds: string[] }} Policy
 *   reddit: whether Reddit is limited to `allow` (once you've run `focus reddit allow`);
 *   feeds: the sites whose feeds are blocked ("youtube", "x").
 * @typedef {"main_frame" | "sub_frame"} FrameType
 * @typedef {{
 *   id: number,
 *   priority: number,
 *   action: { type: "allow" | "block" },
 *   condition: { regexFilter?: string, requestDomains?: string[], resourceTypes: FrameType[] },
 * }} Rule
 */

const FRAMES = /** @type {FrameType[]} */ (["main_frame", "sub_frame"]);
const REDDIT = String.raw`^https?://([a-z0-9-]+\.)*reddit\.com`;
const YOUTUBE = String.raw`^https?://((www|m)\.)?youtube\.com`;
const X = String.raw`^https?://((www|mobile)\.)?(x|twitter)\.com`;
const END = String.raw`([/?#]|$)`;

/** The hostnames each site uses, for matching tabs and navigation events. */
export const SITE_HOSTS = /** @type {const} */ ({
  reddit: ["reddit.com"],
  youtube: ["youtube.com", "youtu.be"],
  x: ["x.com", "twitter.com"],
});

/** A page of each site that its rules block, for Incognito tabs, which can't show focus's own page. */
export const BLOCKED_PAGES = /** @type {const} */ ({
  reddit: "https://www.reddit.com/",
  youtube: "https://www.youtube.com/",
  x: "https://x.com/home",
});

/** Used when nothing has been heard from `focus` yet: everything restricted, as strictly as it gets. */
export const UNKNOWN_POLICY = /** @type {Policy} */ ({ state: "on", reddit: true, allow: [], feeds: ["youtube", "x"] });

/**
 * @param {Policy} policy
 * @returns {Rule[]}
 */
export function buildRules(policy) {
  if (policy.state !== "on") return [];
  return [
    ...(policy.reddit ? redditRules(policy.allow) : []),
    ...(policy.feeds.includes("youtube") ? youtubeRules() : []),
    ...(policy.feeds.includes("x") ? xRules() : []),
  ];
}

/**
 * Reddit, limited to the allowed subreddits. Ids 1-9, and 100 up for the subreddits.
 * @param {string[]} allow
 * @returns {Rule[]}
 */
function redditRules(allow) {
  /** @type {Rule[]} */
  const rules = [
    // Every Reddit page and frame, on reddit.com and all of its subdomains.
    rule(1, 1, "block", { requestDomains: ["reddit.com"] }),
    // Signing in, and Reddit's redirector for links to other sites.
    rule(2, 2, "allow", { regexFilter: `${REDDIT}/(login|register|logout)${END}` }),
    rule(3, 2, "allow", { regexFilter: String.raw`^https?://out\.reddit\.com/` }),
    // Posts without a subreddit in the URL (redd.it/<id> lands on /comments/<id>); comments.js
    // checks which subreddit the post is in.
    rule(4, 2, "allow", { regexFilter: `${REDDIT}/(comments|gallery)/[a-z0-9]+${END}` }, ["main_frame"]),
    // Within a subreddit, pages that show the rest of Reddit stay blocked: search (restrict_sr=off
    // searches everything), duplicates (other subreddits' posts) and the API, including .json and .rss.
    rule(5, 3, "block", { regexFilter: String.raw`${REDDIT}/r/[^/?#]+/(search|duplicates|api)([./?#]|$)` }),
    // An image opened in a tab: i.redd.it sends browsers to this viewer, which shows only that image.
    rule(6, 2, "allow", { regexFilter: `${REDDIT}/media${END}` }, ["main_frame"]),
  ];
  allow.forEach((name, index) => {
    rules.push(rule(100 + index, 2, "allow", { regexFilter: `${REDDIT}/r/${name}${END}` }));
  });
  return rules;
}

/**
 * YouTube's feeds: the home page, Shorts, and Explore/Trending. Videos, search, channels,
 * playlists and subscriptions load; youtube.js hides the recommendations on video pages.
 * Ids 20-29.
 * @returns {Rule[]}
 */
function youtubeRules() {
  return [
    rule(20, 1, "block", { regexFilter: `${YOUTUBE}/?([?#]|$)` }),
    rule(21, 1, "block", { regexFilter: `${YOUTUBE}/shorts${END}` }),
    rule(22, 1, "block", { regexFilter: `${YOUTUBE}/feed/(trending|explore)${END}` }),
  ];
}

/**
 * X's feeds: the Home timeline, Explore and trends, search (hashtags are searches) and
 * notifications. Posts and profiles load. Ids 30-39.
 * @returns {Rule[]}
 */
function xRules() {
  return [
    rule(30, 1, "block", { regexFilter: `${X}/(home|explore|search|hashtag|notifications)${END}` }),
    rule(31, 1, "block", { regexFilter: `${X}/i/trends${END}` }),
  ];
}

/**
 * The site a URL belongs to, or null.
 * @param {string} url
 * @returns {Site | null}
 */
export function siteOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [site, hosts] of Object.entries(SITE_HOSTS)) {
    if (hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return /** @type {Site} */ (site);
  }
  return null;
}

/**
 * @param {number} id
 * @param {number} priority
 * @param {"allow" | "block"} type
 * @param {{ regexFilter?: string, requestDomains?: string[] }} match
 * @param {FrameType[]} resourceTypes
 * @returns {Rule}
 */
function rule(id, priority, type, match, resourceTypes = FRAMES) {
  return { id, priority, action: { type }, condition: { ...match, resourceTypes } };
}

/**
 * What Chrome would do with a request: the highest-priority matching rule wins,
 * and at equal priority allow beats block. Returns null when no rule matches.
 * Regexes are case-insensitive, like DNR's default.
 *
 * @param {Rule[]} rules
 * @param {string} url
 * @param {FrameType} resourceType
 * @returns {"allow" | "block" | null}
 */
export function evaluate(rules, url, resourceType = "main_frame") {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  /** @type {Rule | null} */
  let winner = null;
  for (const candidate of rules) {
    const { condition } = candidate;
    if (!condition.resourceTypes.includes(resourceType)) continue;
    if (condition.requestDomains && !condition.requestDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
      continue;
    }
    if (condition.regexFilter && !new RegExp(condition.regexFilter, "i").test(url)) continue;
    if (
      !winner ||
      candidate.priority > winner.priority ||
      (candidate.priority === winner.priority && candidate.action.type === "allow")
    ) {
      winner = candidate;
    }
  }
  return winner ? winner.action.type : null;
}

/**
 * @param {Policy} policy
 * @param {string} url
 */
export function isAllowed(policy, url) {
  return evaluate(buildRules(policy), url) !== "block";
}

/**
 * Whether a page may stay open. A post page reports the subreddit its canonical link
 * names (comments.js), and that must be allowed too: a bare /comments/<id> URL doesn't
 * say, and /r/<allowed>/comments/<id> could be a post from anywhere.
 *
 * @param {Policy} policy
 * @param {string} url
 * @param {string | null} subreddit the subreddit the page reported, if any
 */
export function mayStay(policy, url, subreddit = null) {
  if (!isAllowed(policy, url)) return false;
  if (policy.state !== "on" || !policy.reddit || siteOf(url) !== "reddit") return true;
  if (subreddit !== null) return policy.allow.includes(subreddit.toLowerCase());
  return !isBarePost(url);
}

/**
 * A post's id, for /comments/<id>, /gallery/<id> and /r/<name>/comments/<id>, or null.
 * @param {string} url
 */
export function postIdOf(url) {
  if (siteOf(url) !== "reddit") return null;
  try {
    return /^(?:\/r\/[^/]+)?\/(?:comments|gallery)\/([a-z0-9]+)(?:[/?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * A post page whose URL doesn't name its subreddit: /comments/<id> or /gallery/<id>.
 * @param {string} url
 */
export function isBarePost(url) {
  return postIdOf(url) !== null && subredditOf(url) === null;
}

/**
 * The subreddit a URL is in, lowercased, or null.
 * @param {string} url
 */
export function subredditOf(url) {
  try {
    return /^\/r\/([^/?#]+)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
