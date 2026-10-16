// @ts-check
// Keeps Chrome's blocking rules in step with focus. Every decision is made from
// the cached policy, synchronously; the cache is refreshed by asking the focus
// binary (a one-shot native message, so nothing keeps running in between).
import { PROTOCOL, UNKNOWN_POLICY, buildRules, isAllowed, isBarePost, mayStay, postIdOf } from "./rules.js";

const HOST = "com.brentvatne.focus";
const REDDIT_TABS = ["*://*.reddit.com/*"];
const REDDIT_EVENTS = { url: [{ hostSuffix: "reddit.com" }] };
const REINSTALL = "If this persists, run `focus reddit install`.";
// Where Incognito tabs go: extension pages can't open there, but Chrome's own blocked page can.
const BLOCKED_IN_INCOGNITO = "https://www.reddit.com/";

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

async function cachedPolicy() {
  if (!policy) {
    const stored = await chrome.storage.local.get("policy");
    policy = /** @type {Policy | undefined} */ (stored.policy) ?? null;
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
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(HOST, {
      type: "status",
      protocol: PROTOCOL,
      extensionVersion: manifest.version_name ?? null,
    });
  } catch (error) {
    await chrome.storage.local.set({ hostError: `Chrome couldn't run focus: ${messageOf(error)}. ${REINSTALL}` });
    return;
  }
  if (!reply || typeof reply !== "object" || (reply.state !== "error" && !isPolicyReply(reply))) {
    await chrome.storage.local.set({ hostError: `focus sent an unexpected reply. ${REINSTALL}` });
    return;
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
  const next = { state: reply.state, allow: reply.allow };
  const changed = JSON.stringify(await cachedPolicy()) !== JSON.stringify(next);
  // Rules first, then the cache: the cache is never ahead of what Chrome enforces, so
  // sending a tab away can't be undone by rules that still let it load.
  if (changed) await installRules(next);
  policy = next;
  // A broken allowlist arrives as an empty one: everything blocked while on, and off still off.
  const hostError = reply.allowlistError ? `focus couldn't read the allowed subreddits: ${reply.allowlistError}` : null;
  await chrome.storage.local.set({ policy: next, hostError, checkedAt: Date.now() });
  if (changed) await sweepTabs();
}

/** @param {Record<string, unknown>} reply */
function isPolicyReply(reply) {
  return (
    ["on", "off", "none"].includes(/** @type {string} */ (reply.state)) &&
    Array.isArray(reply.allow) &&
    reply.allow.every((name) => typeof name === "string")
  );
}

/** Sends every open Reddit tab that's no longer allowed away. */
async function sweepTabs() {
  for (const tab of await chrome.tabs.query({ url: REDDIT_TABS })) {
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
 * @param {{ reloadUnreported: boolean }} options
 */
async function checkTab(tabId, url, { reloadUnreported }) {
  const current = await cachedPolicy();
  if (!isAllowed(current, url)) return enforce(tabId, url);
  const postId = postIdOf(url);
  if (current.state !== "on" || postId === null) return;
  const report = (await reports())[tabId];
  if (report?.postId === postId) {
    if (!mayStay(current, url, report.subreddit)) await enforce(tabId, url, report.subreddit);
  } else if (reloadUnreported && isBarePost(url) && once(recentlyReloaded, tabId, url)) {
    await chrome.tabs.reload(tabId).catch(() => {});
  }
}

/**
 * Leaves a page Reddit shouldn't show. In a regular window that's focus's blocked page.
 * In Incognito, where a spanning extension can't open its own pages, it's a Reddit URL the
 * rules block, so Chrome shows its own blocked page: the page itself if the rules block it,
 * otherwise (a post judged by its reported subreddit) Reddit's home page.
 *
 * @param {number} tabId
 * @param {string} url
 * @param {string | null} subreddit for a post page, the subreddit it reported
 */
async function enforce(tabId, url, subreddit = null) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const query = subreddit ? `?subreddit=${encodeURIComponent(subreddit)}` : "";
  const target = tab.incognito
    ? isAllowed(await cachedPolicy(), url)
      ? BLOCKED_IN_INCOGNITO
      : url
    : chrome.runtime.getURL(`blocked.html${query}#${encodeURIComponent(url)}`);
  await chrome.tabs.update(tabId, { url: target }).catch(() => {});
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
  // Only spend a process on it while Reddit is actually open.
  if ((await chrome.tabs.query({ url: REDDIT_TABS })).length > 0) await refresh();
});

// The rules for this navigation are already decided; this refreshes them for the next one.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) void refresh();
}, REDDIT_EVENTS);

// Client-side route changes and pages served by Reddit's service worker never reach the rules.
// A route change keeps the old document, so a post there can't report itself without a reload.
// A committed page loads comments.js, which reports for itself.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) void checkTab(details.tabId, details.url, { reloadUnreported: true });
}, REDDIT_EVENTS);
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) void checkTab(details.tabId, details.url, { reloadUnreported: false });
}, REDDIT_EVENTS);

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
    if (once(recentlyRetried, details.tabId, details.url)) {
      await chrome.tabs.update(details.tabId, { url: details.url }).catch(() => {});
    }
    return;
  }
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (tab && !tab.incognito) await enforce(details.tabId, details.url);
}, REDDIT_EVENTS);

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
      if (!mayStay(await cachedPolicy(), url, subreddit)) await enforce(tabId, url, subreddit);
    })();
  }
  return false;
});
