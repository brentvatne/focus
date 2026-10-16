// @ts-check
// Keeps Chrome's blocking rules in step with focus. Every decision is made from
// the cached policy, synchronously; the cache is refreshed by asking the focus
// binary (a one-shot native message, so nothing keeps running in between).
import { PROTOCOL, UNKNOWN_POLICY, buildRules, isAllowed, mayStay } from "./rules.js";

const HOST = "com.brentvatne.focus";
const REDDIT_TABS = ["*://*.reddit.com/*"];
const REDDIT_EVENTS = { url: [{ hostSuffix: "reddit.com" }] };

/** @typedef {import("./rules.js").Policy} Policy */

/** @type {Policy | null} */
let policy = null;
/** @type {Promise<void> | null} */
let refreshing = null;
let refreshAgain = false;
/** Tab id -> URL and time it was last retried after a block by out-of-date rules. */
const recentlyRetried = new Map();

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
    do {
      refreshAgain = false;
      await refreshOnce();
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
    await chrome.storage.local.set({ hostError: `Chrome couldn't run focus: ${messageOf(error)}` });
    return;
  }
  if (!reply || typeof reply !== "object") {
    await chrome.storage.local.set({ hostError: "focus sent an unexpected reply" });
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
    const why = reply.state === "error" ? reply.error : `focus ${reply.version} speaks a different protocol; update focus`;
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
  await chrome.storage.local.set({ policy: next, hostError: null, checkedAt: Date.now() });
  if (changed) await sweepTabs();
}

/** Sends every open Reddit tab that's no longer allowed away. */
async function sweepTabs() {
  const current = await cachedPolicy();
  for (const tab of await chrome.tabs.query({ url: REDDIT_TABS })) {
    if (tab.id !== undefined && tab.url && !isAllowed(current, tab.url)) await enforce(tab.id, tab.url);
  }
}

/**
 * Leaves a page Reddit shouldn't show. In a regular window that's focus's blocked page.
 * In Incognito, where a spanning extension can't open its own pages, it's a real reload,
 * which the block rule stops with Chrome's own error page.
 *
 * @param {number} tabId
 * @param {string} url
 * @param {string | null} subreddit for a bare comments page, the subreddit it reported
 */
async function enforce(tabId, url, subreddit = null) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const query = subreddit ? `?subreddit=${encodeURIComponent(subreddit)}` : "";
  const target = tab.incognito ? url : chrome.runtime.getURL(`blocked.html${query}#${encodeURIComponent(url)}`);
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

/** @param {{ tabId: number, frameId: number, url: string }} details */
async function checkNavigation(details) {
  if (details.frameId !== 0) return;
  if (!isAllowed(await cachedPolicy(), details.url)) await enforce(details.tabId, details.url);
}

async function start() {
  await installRules(await cachedPolicy());
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
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => void checkNavigation(details), REDDIT_EVENTS);
chrome.webNavigation.onCommitted.addListener((details) => void checkNavigation(details), REDDIT_EVENTS);

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
  if (message?.type === "comments" && sender.tab?.id !== undefined) {
    // From comments.js: a bare /comments/<id> page, and the subreddit its canonical link names.
    const tabId = sender.tab.id;
    const subreddit = typeof message.subreddit === "string" ? message.subreddit.toLowerCase() : null;
    void cachedPolicy().then((current) => {
      if (!mayStay(current, message.url, subreddit)) void enforce(tabId, message.url, subreddit);
    });
  }
  return false;
});
