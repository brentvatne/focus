import { describe, expect, test } from "bun:test";
import { normalizeHostname } from "../src/hostname.ts";
import { PRESETS, findPreset } from "../src/presets.ts";

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
