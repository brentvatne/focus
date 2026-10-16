import { describe, expect, test } from "bun:test";
import { normalizeHostname } from "../src/hostname.ts";
import {
  PRESETS,
  type Preset,
  findPreset,
  presetBlocking,
  suggestPresets,
  syncSection,
  withPresets,
} from "../src/presets.ts";

describe("PRESETS", () => {
  test("ids are unique", () => {
    const ids = PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(PRESETS.map((preset) => [preset.id, preset.hosts] as const))(
    "%s lists valid, normalized, unique hostnames",
    (_, hosts) => {
      expect(hosts.length).toBeGreaterThan(0);
      for (const host of hosts) expect(normalizeHostname(host)).toBe(host);
      expect(new Set(hosts).size).toBe(hosts.length);
    },
  );

  test("no hostname belongs to two presets", () => {
    const all = PRESETS.flatMap((preset) => preset.hosts);
    expect(new Set(all).size).toBe(all.length);
  });

  test("recommends X, Facebook, YouTube and Reddit", () => {
    expect(PRESETS.filter((preset) => preset.recommended).map((preset) => preset.id)).toEqual([
      "x",
      "facebook",
      "youtube",
      "reddit",
    ]);
  });

  test("keeps Messenger separate from Facebook and off by default", () => {
    expect(findPreset("facebook")!.hosts.some((host) => host.includes("messenger"))).toBe(false);
    expect(findPreset("messenger")).toMatchObject({ recommended: false, hosts: ["messenger.com", "www.messenger.com"] });
  });

  test("findPreset ignores case", () => {
    expect(findPreset("YouTube")?.id).toBe("youtube");
    expect(findPreset("myspace")).toBeUndefined();
  });
});

describe("syncSection", () => {
  const catalog: Preset[] = [
    { id: "video", name: "Video", hosts: ["video.com", "www.video.com", "api.video.com"], recommended: true },
    { id: "news", name: "News", hosts: ["news.com"], recommended: false },
  ];
  const section = (presets: { id: string; hosts: string[] }[], sites: string[] = [], legacy = false) => ({
    state: "on" as const,
    presets,
    sites,
    legacy,
  });

  test("adds hosts a newer version added to a preset and drops ones it removed", () => {
    const old = section([{ id: "video", hosts: ["video.com", "www.video.com", "old.video.com"] }]);
    expect(syncSection(old, catalog)).toEqual({
      state: "on",
      presets: [{ id: "video", hosts: ["video.com", "www.video.com", "api.video.com"] }],
      sites: [],
    });
  });

  test("keeps the hosts of a preset that no longer exists as sites", () => {
    expect(syncSection(section([{ id: "gone", hosts: ["gone.com"] }], ["a.com"]), catalog)).toEqual({
      state: "on",
      presets: [],
      sites: ["a.com", "gone.com"],
    });
  });

  test("drops sites that an enabled preset already covers and orders presets like the catalog", () => {
    const synced = syncSection(
      section([{ id: "news", hosts: [] }, { id: "video", hosts: [] }], ["api.video.com", "a.com"]),
      catalog,
    );
    expect(synced.presets.map((group) => group.id)).toEqual(["video", "news"]);
    expect(synced.sites).toEqual(["a.com"]);
  });

  test("keeps the on/off state", () => {
    expect(syncSection({ ...section([{ id: "news", hosts: [] }]), state: "off" }, catalog).state).toBe("off");
  });

  describe("0.1.0 sections", () => {
    const V0_1_0_X = ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"];

    test("records presets whose 0.1.0 hosts are all present and picks up the new ones", () => {
      const legacy = section([], [...V0_1_0_X, "a.com", "www.a.com", ...findPreset("youtube")!.hosts], true);
      expect(syncSection(legacy)).toEqual({
        state: "on",
        presets: [
          { id: "x", hosts: findPreset("x")!.hosts },
          { id: "youtube", hosts: findPreset("youtube")!.hosts },
        ],
        sites: ["a.com", "www.a.com"],
      });
      expect(findPreset("x")!.hosts).toContain("api.x.com");
    });

    test("doesn't keep a second copy of hosts added by hand that the preset now includes", () => {
      const legacy = section([], [...V0_1_0_X, "api.x.com", "api.twitter.com"], true);
      expect(syncSection(legacy).sites).toEqual([]);
    });

    test("leaves a partial preset as sites", () => {
      const legacy = section([], ["youtube.com", "www.youtube.com"], true);
      expect(syncSection(legacy)).toEqual({ state: "on", presets: [], sites: ["youtube.com", "www.youtube.com"] });
    });

    test("only converts legacy sections", () => {
      const grouped = section([], findPreset("youtube")!.hosts, false);
      expect(syncSection(grouped).presets).toEqual([]);
    });
  });
});

describe("withPresets and presetBlocking", () => {
  test("withPresets sets exactly the given presets and keeps sites and state", () => {
    const current = { state: "off" as const, presets: [{ id: "x", hosts: findPreset("x")!.hosts }], sites: ["a.com"] };
    const next = withPresets(current, ["reddit", "hackernews"]);
    expect(next.state).toBe("off");
    expect(next.presets.map((group) => group.id)).toEqual(["reddit", "hackernews"]);
    expect(next.sites).toEqual(["a.com"]);
    expect(withPresets(null, []).presets).toEqual([]);
  });

  test("presetBlocking finds the enabled preset that owns a host", () => {
    const current = withPresets(null, ["x"]);
    expect(presetBlocking(current, "api.x.com")?.id).toBe("x");
    expect(presetBlocking(current, "youtube.com")).toBeUndefined();
    expect(presetBlocking(null, "x.com")).toBeUndefined();
  });
});

describe("suggestPresets", () => {
  const ids = (word: string) => suggestPresets(word).map((preset) => preset.id);

  test.each([
    ["youtub", "youtube"],
    ["yuotube", "youtube"],
    ["YOUTUBE", "youtube"],
    ["twitter", "x"],
    ["twiter", "x"],
    ["hacker-news", "hackernews"],
    ["Hacker News", "hackernews"],
    ["hacker", "hackernews"],
    ["insta", "instagram"],
    ["tiktk", "tiktok"],
    ["messanger", "messenger"],
    ["reddit.com", "reddit"],
    ["www.facebook.com", "facebook"],
  ])("%s suggests %s", (word, id) => {
    expect(ids(word)).toEqual([id]);
  });

  test.each(["foo", "example", "news", "y", "xx", "fb", "tok", "", "--"])("%p suggests nothing", (word) => {
    expect(ids(word)).toEqual([]);
  });

  test("lists every preset on a tie", () => {
    const catalog: Preset[] = [
      { id: "abcd", name: "Abcd", hosts: ["abcd.com"], recommended: false },
      { id: "abce", name: "Abce", hosts: ["abce.com"], recommended: false },
    ];
    expect(suggestPresets("abcx", catalog).map((preset) => preset.id)).toEqual(["abcd", "abce"]);
  });
});
