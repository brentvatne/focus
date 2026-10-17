// @ts-check
// Keeps Chrome's blocking rules in step with focus. Every decision is made from
// the cached policy, synchronously; the cache is refreshed by asking the focus
// binary (a one-shot native message, so nothing keeps running in between).
import {
  BLOCKED_PAGES,
  INSTAGRAM_INBOX,
  PROTOCOL,
  SITE_HOSTS,
  UNKNOWN_POLICY,
  buildRules,
  isAllowed,
  isBarePost,
  mayStay,
  postIdOf,
  siteOf,
} from "./rules.js";

const HOST = "com.brentvatne.focus";
const HOSTS = Object.values(SITE_HOSTS).flat();
// "*.host" also matches the host itself.
const SITE_TABS = HOSTS.map((host) => `*://*.${host}/*`);
// hostSuffix "x.com" would also match "box.com", so each host is matched exactly or as a subdomain.
const SITE_EVENTS = { url: HOSTS.flatMap((host) => [{ hostEquals: host }, { hostSuffix: `.${host}` }]) };
const REINSTALL = "If this persists, run `focus chrome install`.";

/** @typedef {import("./rules.js").Policy} Policy */

/** @type {Policy | null} */
let policy = null;
/** @type {Promise<void> | null} */
let refreshing = null;
let refreshAgain = false;
/** Whether this service worker has installed the cached rules yet; see refresh(). */
let rulesSynced = false;
/** Tab id -> URL and time it was last retried after a block by out-of-date rules. */
const recentlyRetried = new Map();
/** Tab id -> URL and time it was last reloaded so its post page reports its subreddit. */
const recentlyReloaded = new Map();
/** Tab id -> host and time a blocked page was last counted, so one try counts once. */
const recentlyCounted = new Map();
/** At most this many blocked pages wait to be sent to focus (an older focus doesn't take them). */
const MAX_PENDING = 1000;
/** @type {Promise<unknown>} */
let pendingQueue = Promise.resolve();

/**
 * @typedef {{ postId: string, subreddit: string | null }} Report
 * The subreddit each tab's post page reported, by tab id. Session storage outlives the
 * service worker, so a sweep after a policy change still knows which post a tab shows.
 * @returns {Promise<Record<string, Report>>}
 */
async function reports() {
  const { reports } = await chrome.storage.session.get("reports");
  return /** @type {Record<string, Report> | undefined} */ (reports) ?? {};
}

/** @typedef {{ at: number, host: string, site?: string, mode: "whole" | "partial" }} Blocked A blocked page waiting to be sent to focus for its stats. */

/**
 * Changes the blocked pages waiting to be sent. Every change goes through this queue, so a
 * count can't be lost between a read and a write.
 * @template T
 * @param {(pending: Blocked[]) => { pending?: Blocked[], result: T }} change
 * @returns {Promise<T>}
 */
function withPending(change) {
  const next = pendingQueue.then(async () => {
    const stored = /** @type {Blocked[] | undefined} */ ((await chrome.storage.local.get("pendingStats")).pendingStats) ?? [];
    const { pending, result } = change(stored);
    if (pending) await chrome.storage.local.set({ pendingStats: pending.slice(-MAX_PENDING) });
    return result;
  });
  pendingQueue = next.catch(() => {});
  return next;
}

/**
 * Counts a try to open a page focus blocks, for `focus stats`. Sent with the next request to focus.
 * @param {number} tabId
 * @param {string} url
 * @param {"whole" | "partial"} mode
 */
async function countBlocked(tabId, url, mode) {
  const host = hostOf(url);
  if (!host) return;
  const last = recentlyCounted.get(tabId);
  if (last && last.host === host && Date.now() - last.at < 5000) return;
  recentlyCounted.set(tabId, { host, at: Date.now() });
  const site = siteOf(url);
  /** @type {Blocked} */
  const entry = { at: Date.now(), host, ...(site && mode === "partial" ? { site } : {}), mode };
  await withPending((pending) => ({ pending: [...pending, entry], result: undefined }));
  void refresh();
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The hosts the hosts file blocks while focus is on, as focus last said. */
async function blockedHosts() {
  const { blockedHosts } = await chrome.storage.local.get("blockedHosts");
  return /** @type {string[] | undefined} */ (blockedHosts) ?? [];
}

async function cachedPolicy() {
  if (!policy) {
    const stored = /** @type {Partial<Policy> | undefined} */ ((await chrome.storage.local.get("policy")).policy);
    // Cached by a version from before feeds, which always limited Reddit.
    policy = stored ? /** @type {Policy} */ ({ reddit: true, feeds: [], ...stored }) : null;
  }
  return policy ?? UNKNOWN_POLICY;
}

/** @param {Policy} next */
async function installRules(next) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: /** @type {chrome.declarativeNetRequest.Rule[]} */ (buildRules(next)),
  });
}

/** Asks focus for the current state. One request at a time; a request made meanwhile runs once more afterwards. */
function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    // Before anything else this worker does: Chrome enforces the last known policy (or blocks
    // all of Reddit, before focus has ever answered) even if focus can't be reached. Inside
    // the queue, so it can't overwrite rules a newer answer installed.
    if (!rulesSynced) {
      await installRules(await cachedPolicy());
      rulesSynced = true;
    }
    do {
      refreshAgain = false;
      await refreshOnce().catch(async (error) => {
        await chrome.storage.local.set({ hostError: `focus's answer couldn't be applied: ${messageOf(error)}` });
      });
    } while (refreshAgain);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refreshOnce() {
  const manifest = chrome.runtime.getManifest();
  const record = await withPending((pending) => ({ result: pending }));
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(HOST, {
      type: "status",
      protocol: PROTOCOL,
      extensionVersion: manifest.version_name ?? null,
      ...(record.length > 0 ? { record } : {}),
    });
  } catch (error) {
    await chrome.storage.local.set({ hostError: `Chrome couldn't run focus: ${messageOf(error)}. ${REINSTALL}` });
    return;
  }
  if (!reply || typeof reply !== "object" || (reply.state !== "error" && !isPolicyReply(reply))) {
    await chrome.storage.local.set({ hostError: `focus sent an unexpected reply. ${REINSTALL}` });
    return;
  }
  // focus saved them (a focus from before stats doesn't say so, and they wait for one that does).
  if (record.length > 0 && reply.recorded === record.length) {
    await withPending((pending) => ({ pending: pending.slice(record.length), result: undefined }));
  }
  if (reply.reload) {
    // focus rewrote this extension's files after an upgrade. Reload once per version, never in a loop.
    const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
    if (reloadedFor !== reply.version) {
      await chrome.storage.local.set({ reloadedFor: reply.version });
      chrome.runtime.reload();
      return;
    }
  }
  if (reply.state === "error" || reply.protocol !== PROTOCOL) {
    // Keep the last good rules rather than guessing.
    const why =
      reply.state === "error" || typeof reply.protocol !== "number"
        ? `focus couldn't answer: ${reply.error ?? "no reason given"}`
        : `focus ${reply.version} speaks a different protocol than this extension. ${REINSTALL}`;
    await chrome.storage.local.set({ hostError: why });
    return;
  }
  /** @type {Policy} */
  const next = {
    state: reply.state,
    // A focus from before feeds always limited Reddit and had no feeds.
    reddit: reply.reddit ?? true,
    allow: reply.allow,
    feeds: reply.feeds ?? [],
  };
  const changed = JSON.stringify(await cachedPolicy()) !== JSON.stringify(next);
  // Rules first, then the cache: the cache is never ahead of what Chrome enforces, so
  // sending a tab away can't be undone by rules that still let it load.
  if (changed) await installRules(next);
  policy = next;
  // A broken allowlist arrives as an empty one: everything blocked while on, and off still off.
  const hostError = reply.allowlistError
    ? `focus couldn't read the allowed subreddits: ${reply.allowlistError}`
    : reply.feedsError
      ? `focus couldn't read which feeds to block, so it blocks them all: ${reply.feedsError}`
      : null;
  const hosts = Array.isArray(reply.blockedHosts) ? reply.blockedHosts.filter((/** @type {unknown} */ host) => typeof host === "string") : [];
  await chrome.storage.local.set({ policy: next, hostError, checkedAt: Date.now(), blockedHosts: hosts });
  if (changed) await sweepTabs();
}

/** @param {Record<string, unknown>} reply */
function isPolicyReply(reply) {
  return (
    ["on", "off", "none"].includes(/** @type {string} */ (reply.state)) &&
    Array.isArray(reply.allow) &&
    reply.allow.every((name) => typeof name === "string") &&
    (reply.reddit === undefined || typeof reply.reddit === "boolean") &&
    (reply.feeds === undefined || (Array.isArray(reply.feeds) && reply.feeds.every((id) => typeof id === "string")))
  );
}

/** Sends every open tab that's no longer allowed away. */
async function sweepTabs() {
  for (const tab of await chrome.tabs.query({ url: SITE_TABS })) {
    if (tab.id !== undefined && tab.url) await checkTab(tab.id, tab.url, { reloadUnreported: true });
  }
}

/**
 * Enforces the policy on a tab's current page. A post page is judged by the subreddit it
 * reported. With no report for this post (a client-side route change, or a tab opened
 * before the extension was), `reloadUnreported` reloads a bare post URL once so that
 * comments.js runs and reports; the rules let that reload through.
 *
 * @param {number} tabId
 * @param {string} url
 * @param {{ reloadUnreported: boolean, attempt?: boolean }} options `attempt`: you went to this page,
 *   rather than focus changing under a page already open, so a block counts for stats
 */
async function checkTab(tabId, url, { reloadUnreported, attempt = false }) {
  const current = await cachedPolicy();
  if (!isAllowed(current, url)) return enforce(tabId, url, null, attempt);
  const postId = postIdOf(url);
  if (current.state !== "on" || postId === null) return;
  const report = (await reports())[tabId];
  if (report?.postId === postId) {
    if (!mayStay(current, url, report.subreddit)) await enforce(tabId, url, report.subreddit, attempt);
  } else if (reloadUnreported && isBarePost(url) && once(recentlyReloaded, tabId, url)) {
    await chrome.tabs.reload(tabId).catch(() => {});
  }
}

/**
 * Leaves a page focus blocks. In a regular window that's focus's blocked page. In Incognito,
 * where a spanning extension can't open its own pages, it's a URL of the same site that the
 * rules block, so Chrome shows its own blocked page: the page itself if the rules block it,
 * otherwise (a Reddit post judged by its reported subreddit) the site's blocked home page.
 *
 * @param {number} tabId
 * @param {string} url
 * @param {string | null} subreddit for a post page, the subreddit it reported
 * @param {boolean} attempt count it for stats
 */
async function enforce(tabId, url, subreddit = null, attempt = false) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // Decisions can take a moment (a refresh from focus first); by then the tab may have moved on.
  if (!tab || !stillOn(tab, url)) return;
  if (attempt) await countBlocked(tabId, url, "partial");
  const query = subreddit ? `?subreddit=${encodeURIComponent(subreddit)}` : "";
  const site = siteOf(url);
  // Instagram, limited to messages, always goes to the inbox rather than a blocked page.
  const target =
    site === "instagram"
      ? INSTAGRAM_INBOX
      : tab.incognito
        ? isAllowed(await cachedPolicy(), url) && site
          ? BLOCKED_PAGES[site]
          : url
        : chrome.runtime.getURL(`blocked.html${query}#${encodeURIComponent(url)}`);
  await chrome.tabs.update(tabId, { url: target }).catch(() => {});
}

/**
 * Whether the tab is still on `url`: showing it with nothing else loading, or loading it.
 * A tab that has started loading another page has moved on, even before it commits.
 * @param {chrome.tabs.Tab} tab
 * @param {string} url
 */
function stillOn(tab, url) {
  return (tab.pendingUrl ?? tab.url) === url;
}

/**
 * True the first time a tab and URL are seen within a few seconds.
 * @param {Map<number, { url: string, at: number }>} seen
 * @param {number} tabId
 * @param {string} url
 */
function once(seen, tabId, url) {
  const last = seen.get(tabId);
  if (last && last.url === url && Date.now() - last.at < 3000) return false;
  seen.set(tabId, { url, at: Date.now() });
  return true;
}

async function start() {
  await chrome.alarms.create("sweep", { periodInMinutes: 1 });
  await refresh();
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());

chrome.alarms.onAlarm.addListener(async () => {
  // Only spend a process on it while one of the sites is actually open.
  if ((await chrome.tabs.query({ url: SITE_TABS })).length > 0) await refresh();
});

// The rules for this navigation are already decided; this refreshes them for the next one.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  void refresh();
  // Instagram's rule redirects to the inbox rather than blocking, so no error says it happened.
  if (!isPrerender(details) && siteOf(details.url) === "instagram" && !isAllowed(await cachedPolicy(), details.url)) {
    await countBlocked(details.tabId, details.url, "partial");
  }
}, SITE_EVENTS);

// Client-side route changes and pages served by Reddit's service worker never reach the rules.
// A route change keeps the old document, so a post there can't report itself without a reload.
// A committed page loads comments.js, which reports for itself.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) void checkTab(details.tabId, details.url, { reloadUnreported: true, attempt: true });
}, SITE_EVENTS);
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) void checkTab(details.tabId, details.url, { reloadUnreported: false, attempt: !isPrerender(details) });
}, SITE_EVENTS);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await reports();
  if (!(tabId in all)) return;
  delete all[tabId];
  await chrome.storage.session.set({ reports: all });
});

// A page the rules blocked: show focus's explanation instead of Chrome's error page.
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0 || details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
  // The block used whatever rules were installed when the navigation started; decide on fresh ones.
  await refresh();
  if (isAllowed(await cachedPolicy(), details.url)) {
    // Blocked by rules that were out of date when the navigation started (focus was just
    // turned off, or the subreddit just allowed), so try once more. Another extension's
    // block is retried once and then left alone.
    const tab = await chrome.tabs.get(details.tabId).catch(() => null);
    if (tab && stillOn(tab, details.url) && once(recentlyRetried, details.tabId, details.url)) {
      await chrome.tabs.update(details.tabId, { url: details.url }).catch(() => {});
    }
    return;
  }
  if (!isPrerender(details)) await countBlocked(details.tabId, details.url, "partial");
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (tab && !tab.incognito) await enforce(details.tabId, details.url);
}, SITE_EVENTS);

// A site the hosts file blocks fails to load (it resolves to 0.0.0.0); count the try for stats.
// Any site, not just the extension's, so no filter. Cancelled loads don't count.
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0 || isPrerender(details) || IGNORED_ERRORS.includes(details.error)) return;
  const host = hostOf(details.url);
  if (!host || !(await blockedHosts()).includes(host)) return;
  // Still on? An answer from focus first, since the cached list could be from before `focus off`.
  await refresh();
  if ((await cachedPolicy()).state === "on" && (await blockedHosts()).includes(host)) {
    await countBlocked(details.tabId, details.url, "whole");
  }
});

/** The extension's own blocks (counted above) and loads cancelled by you or a redirect. */
const IGNORED_ERRORS = ["net::ERR_BLOCKED_BY_CLIENT", "net::ERR_ABORTED"];

/**
 * Chrome loads likely next pages ahead of time while you type in the address bar; those aren't tries.
 * @param {{ documentLifecycle?: string }} details
 */
function isPrerender(details) {
  return details.documentLifecycle === "prerender";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "recheck") {
    // From blocked.html: refresh, then say whether the original URL may load now.
    refresh()
      .then(async () => {
        const { hostError } = await chrome.storage.local.get("hostError");
        const current = await cachedPolicy();
        const allowed = mayStay(current, message.url, message.subreddit ?? null);
        sendResponse({ allowed, policy: current, hostError: hostError ?? null });
      })
      .catch((error) => sendResponse({ allowed: false, policy: null, hostError: messageOf(error) }));
    return true;
  }
  if (message?.type === "comments" && sender.tab?.id !== undefined && typeof message.url === "string") {
    // From comments.js: a post page, and the subreddit its canonical link names.
    const tabId = sender.tab.id;
    const url = message.url;
    const subreddit = typeof message.subreddit === "string" ? message.subreddit.toLowerCase() : null;
    const postId = postIdOf(url);
    void (async () => {
      if (postId !== null) {
        await chrome.storage.session.set({ reports: { ...(await reports()), [tabId]: { postId, subreddit } } });
      }
      if (!mayStay(await cachedPolicy(), url, subreddit)) await enforce(tabId, url, subreddit, true);
    })();
  }
  return false;
});
