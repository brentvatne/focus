// Runs extension/background.js against a stand-in for the chrome.* APIs it uses, so the
// enforcement logic is tested without a browser. Each test imports a fresh copy of the
// module, which is what a service worker starting up does.
import { beforeEach, describe, expect, test } from "bun:test";
import { buildRules } from "../extension/rules.js";

type Listener = (...args: any[]) => unknown;
type Tab = { id: number; url: string; incognito: boolean; pendingUrl?: string };
type Reply = Record<string, unknown>;

const ID = "ppkaiojneebcgfinkmccagdflccineob";
const BLOCKED_PAGE = `chrome-extension://${ID}/blocked.html`;

type UrlFilter = { hostEquals?: string; hostSuffix?: string };

class Event {
  listeners: Listener[] = [];
  /** The webNavigation URL filters each listener was added with. */
  filters: UrlFilter[][] = [];
  addListener(listener: Listener, filter?: { url: UrlFilter[] }) {
    this.listeners.push(listener);
    if (filter) this.filters.push(filter.url);
  }
  async fire(...args: unknown[]) {
    return Promise.all(this.listeners.map((listener) => listener(...args)));
  }
}

function fakeChrome() {
  const state = {
    storage: {} as Record<string, unknown>,
    session: {} as Record<string, unknown>,
    rules: [] as unknown[],
    /** Every rule set installed, in order. */
    installs: [] as unknown[][],
    /** Delay in ms for each updateDynamicRules call, in order; 0 once they run out. */
    installDelays: [] as number[],
    tabs: new Map<number, Tab>(),
    /** What the native host answers; a function to vary or delay it. */
    reply: (): Reply | Promise<Reply> => status("on", ["rust"]),
    navigations: [] as { tabId: number; url: string }[],
    reloads: [] as number[],
    nativeCalls: 0,
  };
  const events = {
    onInstalled: new Event(),
    onStartup: new Event(),
    onMessage: new Event(),
    onAlarm: new Event(),
    onBeforeNavigate: new Event(),
    onHistoryStateUpdated: new Event(),
    onCommitted: new Event(),
    onErrorOccurred: new Event(),
    onRemoved: new Event(),
  };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.1.3", version_name: "0.1.3" }),
      getURL: (path: string) => `chrome-extension://${ID}/${path}`,
      reload: () => {},
      sendNativeMessage: async () => {
        state.nativeCalls++;
        return state.reply();
      },
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
    },
    storage: {
      local: {
        get: async (key: string) => (key in state.storage ? { [key]: state.storage[key] } : {}),
        set: async (values: Record<string, unknown>) => void Object.assign(state.storage, values),
      },
      session: {
        get: async (key: string) => (key in state.session ? { [key]: structuredClone(state.session[key]) } : {}),
        set: async (values: Record<string, unknown>) => void Object.assign(state.session, structuredClone(values)),
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => state.rules,
      updateDynamicRules: async ({ addRules }: { addRules: unknown[] }) => {
        await new Promise((resolve) => setTimeout(resolve, state.installDelays.shift() ?? 0));
        state.rules = addRules;
        state.installs.push(addRules);
      },
    },
    alarms: { create: async () => {}, onAlarm: events.onAlarm },
    tabs: {
      // Match patterns like *://*.reddit.com/*, where *. also matches the bare host.
      query: async ({ url: patterns }: { url: string[] }) =>
        [...state.tabs.values()].filter((tab) =>
          patterns.some((pattern) => {
            const host = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(pattern)![1]!;
            const tabHost = new URL(tab.url).hostname;
            return tabHost === host || tabHost.endsWith(`.${host}`);
          }),
        ),
      get: async (id: number) => {
        const tab = state.tabs.get(id);
        if (!tab) throw new Error("no tab");
        return tab;
      },
      update: async (id: number, { url }: { url: string }) => {
        state.navigations.push({ tabId: id, url });
        const tab = state.tabs.get(id);
        if (tab) tab.url = url;
        return tab;
      },
      reload: async (id: number) => {
        state.reloads.push(id);
      },
      onRemoved: events.onRemoved,
    },
    webNavigation: {
      onBeforeNavigate: events.onBeforeNavigate,
      onHistoryStateUpdated: events.onHistoryStateUpdated,
      onCommitted: events.onCommitted,
      onErrorOccurred: events.onErrorOccurred,
    },
  };
  return { chrome, state, events };
}

function status(state: "on" | "off" | "none", allow: string[], extra: Reply = {}): Reply {
  return { protocol: 1, version: "0.1.3", state, reddit: true, allow, feeds: [], redditBlockedByHosts: false, reload: false, ...extra };
}

/** Lets queued promise callbacks (the module's void-ed async work) run. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let loads = 0;
let fake: ReturnType<typeof fakeChrome>;

async function startWorker(event: "onInstalled" | "onStartup" | null = "onStartup") {
  (globalThis as any).chrome = fake.chrome;
  await import(`../extension/background.js?worker=${++loads}`);
  if (event) await fake.events[event].fire({});
  await settle();
}

function openTab(id: number, url: string, incognito = false) {
  fake.state.tabs.set(id, { id, url, incognito });
}

/** A client-side route change: the tab's URL changes, then Chrome reports it. */
async function route(tabId: number, url: string) {
  fake.state.tabs.get(tabId)!.url = url;
  await fake.events.onHistoryStateUpdated.fire({ frameId: 0, tabId, url });
}

/** comments.js on a post page reporting the subreddit its canonical link names, as it does at load. */
async function reportComments(tabId: number, subreddit: string | null) {
  const tab = fake.state.tabs.get(tabId)!;
  await fake.events.onMessage.fire({ type: "comments", url: tab.url, subreddit }, { tab }, () => {});
  await settle();
}

beforeEach(() => {
  fake = fakeChrome();
});

describe("startup", () => {
  test("installs the rules for focus's answer", async () => {
    await startWorker();
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: true, allow: ["rust"], feeds: [] }));
  });

  test("restricts everything it can before focus has ever answered", async () => {
    fake.state.reply = () => {
      throw new Error("Specified native messaging host not found.");
    };
    await startWorker("onInstalled");
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: true, allow: [], feeds: ["youtube", "x"] }));
    expect(fake.state.storage.hostError).toContain("Chrome couldn't run focus");
  });
});

describe("startup", () => {
  test("the cached rules can't land after newer ones", async () => {
    fake.state.storage.policy = { state: "on", reddit: true, allow: [], feeds: [] };
    // The first install (the cached rules) is slow; focus answers meanwhile.
    fake.state.installDelays = [50];
    await startWorker(null);
    void fake.events.onStartup.fire({});
    void fake.events.onBeforeNavigate.fire({ frameId: 0, tabId: 1, url: "https://www.reddit.com/r/rust/" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    expect(fake.state.installs).toEqual([buildRules({ state: "on", reddit: true, allow: [], feeds: [] }), buildRules({ state: "on", reddit: true, allow: ["rust"], feeds: [] })]);
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: true, allow: ["rust"], feeds: [] }));
  });
});

describe("replies", () => {
  test("a broken allowlist allows nothing and says why", async () => {
    fake.state.reply = () => status("on", [], { allowlistError: "subreddits.json: invalid JSON" });
    await startWorker();
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: true, allow: [], feeds: [] }));
    expect(fake.state.storage.hostError).toBe("focus couldn't read the allowed subreddits: subreddits.json: invalid JSON");
  });

  test("a broken allowlist still lets focus off turn blocking off", async () => {
    fake.state.reply = () => status("off", [], { allowlistError: "subreddits.json: invalid JSON" });
    await startWorker();
    expect(fake.state.rules).toEqual([]);
  });

  test.each([
    ["an error", { protocol: 1, version: "0.1.3", state: "error", allow: [], error: "the hosts file is malformed" }, "focus couldn't answer: the hosts file is malformed"],
    ["a refusal", { error: "focus only answers status requests" }, "focus sent an unexpected reply"],
    ["an unknown state", status("paused" as never, []), "focus sent an unexpected reply"],
    ["a malformed allowlist", status("on", "rust" as never), "focus sent an unexpected reply"],
  ])("%s keeps the last rules", async (_, reply, message) => {
    fake.state.storage.policy = { state: "on", reddit: true, allow: ["rust"], feeds: [] };
    fake.state.reply = () => reply as Reply;
    await startWorker();
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: true, allow: ["rust"], feeds: [] }));
    expect(fake.state.storage.hostError).toStartWith(message);
  });
});

describe("feeds", () => {
  const feedsOnly = () => status("on", [], { reddit: false, feeds: ["youtube", "x"] });

  test("a client-side route to YouTube's home goes to the blocked page; videos stay", async () => {
    fake.state.reply = feedsOnly;
    await startWorker();
    openTab(1, "https://www.youtube.com/watch?v=abc");
    await route(1, "https://www.youtube.com/watch?v=def");
    await settle();
    expect(fake.state.navigations).toEqual([]);
    await route(1, "https://www.youtube.com/");
    await settle();
    expect(fake.state.navigations).toEqual([
      { tabId: 1, url: `${BLOCKED_PAGE}#${encodeURIComponent("https://www.youtube.com/")}` },
    ]);
  });

  test("an open X timeline is sent away when its feed starts being blocked", async () => {
    fake.state.reply = () => status("on", [], { reddit: false, feeds: [] });
    await startWorker();
    openTab(1, "https://x.com/home");
    fake.state.reply = feedsOnly;
    await fake.events.onAlarm.fire({ name: "sweep" });
    await settle();
    expect(fake.state.navigations).toEqual([{ tabId: 1, url: `${BLOCKED_PAGE}#${encodeURIComponent("https://x.com/home")}` }]);
  });

  test("Reddit is left alone while it isn't limited", async () => {
    fake.state.reply = feedsOnly;
    await startWorker();
    openTab(1, "https://www.reddit.com/comments/def456");
    await reportComments(1, "pics");
    await route(1, "https://www.reddit.com/r/pics/");
    await settle();
    expect(fake.state.navigations).toEqual([]);
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: false, allow: [], feeds: ["youtube", "x"] }));
  });

  test("navigation events cover each site's hosts and subdomains, and nothing that merely ends the same", async () => {
    await startWorker();
    const [filter] = fake.events.onHistoryStateUpdated.filters;
    const matches = (host: string) =>
      filter!.some((f) => (f.hostEquals !== undefined && host === f.hostEquals) || (f.hostSuffix !== undefined && host.endsWith(f.hostSuffix)));
    for (const host of ["x.com", "mobile.x.com", "twitter.com", "www.youtube.com", "youtu.be", "old.reddit.com", "reddit.com"]) {
      expect(matches(host)).toBe(true);
    }
    for (const host of ["box.com", "notreddit.com", "fooyoutube.com"]) expect(matches(host)).toBe(false);
  });

  test("a policy cached before feeds keeps limiting Reddit and blocks no feeds", async () => {
    fake.state.storage.policy = { state: "on", allow: ["rust"] };
    fake.state.reply = () => {
      throw new Error("Specified native messaging host not found.");
    };
    await startWorker();
    expect(fake.state.rules).toEqual(buildRules({ state: "on", reddit: true, allow: ["rust"], feeds: [] }));
  });
});

describe("blocked loads", () => {
  test("a slow decision doesn't pull a tab back from a page it has since moved to", async () => {
    fake.state.reply = () => status("on", [], { reddit: false, feeds: ["youtube"] });
    await startWorker();
    let answer!: (reply: Reply) => void;
    fake.state.reply = () => new Promise((resolve) => (answer = resolve));
    openTab(1, "https://www.youtube.com/shorts/abc");
    void fake.events.onErrorOccurred.fire({ frameId: 0, tabId: 1, url: "https://www.youtube.com/shorts/abc", error: "net::ERR_BLOCKED_BY_CLIENT" });
    await settle();
    // You click through to a video while focus is still being asked.
    fake.state.tabs.get(1)!.url = "https://www.youtube.com/watch?v=abc";
    answer(status("on", [], { reddit: false, feeds: ["youtube"] }));
    await settle();
    expect(fake.state.navigations).toEqual([]);
  });

  test("a decision about a page doesn't cancel a newer load that hasn't committed yet", async () => {
    fake.state.reply = () => status("on", [], { reddit: false, feeds: ["youtube"] });
    await startWorker();
    let answer!: (reply: Reply) => void;
    fake.state.reply = () => new Promise((resolve) => (answer = resolve));
    openTab(1, "https://www.youtube.com/");
    void fake.events.onErrorOccurred.fire({ frameId: 0, tabId: 1, url: "https://www.youtube.com/", error: "net::ERR_BLOCKED_BY_CLIENT" });
    await settle();
    fake.state.tabs.get(1)!.pendingUrl = "https://www.youtube.com/results?search_query=rust";
    answer(status("on", [], { reddit: false, feeds: ["youtube"] }));
    await settle();
    expect(fake.state.navigations).toEqual([]);
  });

  test("a blocked load still showing gets the blocked page", async () => {
    fake.state.reply = () => status("on", [], { reddit: false, feeds: ["youtube"] });
    await startWorker();
    openTab(1, "https://www.youtube.com/shorts/abc");
    await fake.events.onErrorOccurred.fire({ frameId: 0, tabId: 1, url: "https://www.youtube.com/shorts/abc", error: "net::ERR_BLOCKED_BY_CLIENT" });
    await settle();
    expect(fake.state.navigations).toEqual([
      { tabId: 1, url: `${BLOCKED_PAGE}#${encodeURIComponent("https://www.youtube.com/shorts/abc")}` },
    ]);
  });
});

describe("post pages", () => {
  const BARE = "https://www.reddit.com/comments/def456";

  test("a bare post from a blocked subreddit goes to the blocked page, naming the subreddit", async () => {
    await startWorker();
    openTab(1, BARE);
    await reportComments(1, "pics");
    expect(fake.state.navigations).toEqual([
      { tabId: 1, url: `${BLOCKED_PAGE}?subreddit=pics#${encodeURIComponent(BARE)}` },
    ]);
  });

  test("a bare post from an allowed subreddit stays", async () => {
    await startWorker();
    openTab(1, BARE);
    await reportComments(1, "Rust");
    expect(fake.state.navigations).toEqual([]);
  });

  test("a post under an allowed subreddit's URL is judged by the subreddit it's really in", async () => {
    await startWorker();
    openTab(1, "https://old.reddit.com/r/rust/comments/def456/title/");
    await reportComments(1, "pics");
    expect(fake.state.navigations).toHaveLength(1);
    expect(fake.state.navigations[0]!.url).toStartWith(`${BLOCKED_PAGE}?subreddit=pics#`);
  });

  test("in Incognito, a blocked post goes to a page the rules block instead of reloading itself", async () => {
    await startWorker();
    openTab(1, BARE, true);
    await reportComments(1, "pics");
    expect(fake.state.navigations).toEqual([{ tabId: 1, url: "https://www.reddit.com/" }]);
    expect(fake.state.reloads).toEqual([]);
  });

  test("in Incognito, a client-side route to YouTube's home reloads it so Chrome blocks it", async () => {
    fake.state.reply = () => status("on", [], { reddit: false, feeds: ["youtube"] });
    await startWorker();
    openTab(1, "https://www.youtube.com/watch?v=abc", true);
    await route(1, "https://www.youtube.com/");
    await settle();
    expect(fake.state.navigations).toEqual([{ tabId: 1, url: "https://www.youtube.com/" }]);
  });

  test("in Incognito, a page the rules block is reloaded so Chrome blocks it", async () => {
    fake.state.reply = () => status("off", []);
    await startWorker();
    openTab(1, "https://www.reddit.com/r/pics/", true);
    fake.state.reply = () => status("on", ["rust"]);
    await fake.events.onAlarm.fire({ name: "sweep" });
    await settle();
    expect(fake.state.navigations).toEqual([{ tabId: 1, url: "https://www.reddit.com/r/pics/" }]);
  });

  test("turning focus on sends away a bare post that was open while it was off", async () => {
    fake.state.reply = () => status("off", []);
    await startWorker();
    openTab(1, BARE);
    await reportComments(1, "pics");
    expect(fake.state.navigations).toEqual([]);
    fake.state.reply = () => status("on", ["rust"]);
    await fake.events.onAlarm.fire({ name: "sweep" });
    await settle();
    expect(fake.state.navigations).toHaveLength(1);
    expect(fake.state.navigations[0]!.url).toStartWith(`${BLOCKED_PAGE}?subreddit=pics#`);
  });

  test("disallowing a subreddit sends away its open bare posts, and keeps the others", async () => {
    fake.state.reply = () => status("on", ["rust", "pics"]);
    await startWorker();
    openTab(1, BARE);
    await reportComments(1, "pics");
    openTab(2, "https://www.reddit.com/comments/abc123");
    await reportComments(2, "rust");
    fake.state.reply = () => status("on", ["rust"]);
    await fake.events.onAlarm.fire({ name: "sweep" });
    await settle();
    expect(fake.state.navigations.map((navigation) => navigation.tabId)).toEqual([1]);
  });

  test("a bare post that never reported is reloaded once on a policy change, so it reports", async () => {
    fake.state.reply = () => status("off", []);
    await startWorker();
    openTab(1, BARE);
    fake.state.reply = () => status("on", ["rust"]);
    await fake.events.onAlarm.fire({ name: "sweep" });
    await settle();
    expect(fake.state.reloads).toEqual([1]);
    expect(fake.state.navigations).toEqual([]);
  });

  test("a client-side route to a bare post reloads it once; a report for that post stops the reloads", async () => {
    await startWorker();
    openTab(1, "https://www.reddit.com/r/rust/");
    await reportComments(1, null);
    fake.state.tabs.get(1)!.url = BARE;
    await route(1, BARE);
    await settle();
    expect(fake.state.reloads).toEqual([1]);
    // The reloaded page reports, then Reddit rewrites the URL in place.
    await reportComments(1, "rust");
    await route(1, BARE);
    await settle();
    expect(fake.state.reloads).toEqual([1]);
    expect(fake.state.navigations).toEqual([]);
  });

  test("a freshly loaded bare post waits for its own report instead of reloading", async () => {
    await startWorker();
    openTab(1, BARE);
    await fake.events.onCommitted.fire({ frameId: 0, tabId: 1, url: BARE });
    await settle();
    expect(fake.state.reloads).toEqual([]);
    expect(fake.state.navigations).toEqual([]);
  });

  test("client-side routes between allowed pages are left alone", async () => {
    await startWorker();
    openTab(1, "https://www.reddit.com/r/rust/");
    const url = "https://www.reddit.com/r/rust/comments/abc123/title/";
    await fake.events.onHistoryStateUpdated.fire({ frameId: 0, tabId: 1, url });
    await settle();
    expect(fake.state.reloads).toEqual([]);
    expect(fake.state.navigations).toEqual([]);
  });

  test("a client-side route to a blocked subreddit goes to the blocked page", async () => {
    await startWorker();
    openTab(1, "https://www.reddit.com/r/rust/");
    await route(1, "https://www.reddit.com/r/pics/");
    await settle();
    expect(fake.state.navigations).toEqual([
      { tabId: 1, url: `${BLOCKED_PAGE}#${encodeURIComponent("https://www.reddit.com/r/pics/")}` },
    ]);
  });

  test("closing a tab forgets its report", async () => {
    await startWorker();
    openTab(1, BARE);
    await reportComments(1, "rust");
    expect(fake.state.session.reports).toEqual({ 1: { postId: "def456", subreddit: "rust" } });
    await fake.events.onRemoved.fire(1);
    await settle();
    expect(fake.state.session.reports).toEqual({});
  });
});
