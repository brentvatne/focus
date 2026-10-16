import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SUBREDDITS,
  SubredditError,
  defaultAllowlistPath,
  normalizeSubreddit,
  readAllowlist,
  writeAllowlist,
} from "../src/subreddits.ts";

describe("normalizeSubreddit", () => {
  test.each([
    ["rust", "rust"],
    ["Rust", "rust"],
    ["r/rust", "rust"],
    ["/r/rust/", "rust"],
    ["de", "de"],
    ["AskHistorians", "askhistorians"],
    ["https://www.reddit.com/r/rust/comments/abc/title/", "rust"],
    ["old.reddit.com/r/Rust", "rust"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeSubreddit(input)).toBe(expected);
  });

  test.each([
    ["all", /feed/],
    ["r/popular", /feed/],
    ["rust+pics", /separately/],
    ["a", /valid subreddit name/],
    ["way_too_long_for_a_subreddit", /valid subreddit name/],
    ["has-dash", /valid subreddit name/],
    ["https://example.com/r/rust", /isn't a subreddit URL/],
    ["https://www.reddit.com/user/x", /isn't a subreddit URL/],
  ])("rejects %s", (input, message) => {
    expect(() => normalizeSubreddit(input)).toThrow(message);
  });
});

describe("allowlist file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "focus-subreddits-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("lives at a fixed path under the home folder", () => {
    expect(defaultAllowlistPath("/Users/me")).toBe("/Users/me/.config/focus/subreddits.json");
  });

  test("reads as empty when missing", async () => {
    expect(await readAllowlist(join(dir, "nope.json"))).toEqual({ path: join(dir, "nope.json"), found: false, allow: [] });
  });

  test("round-trips, creating missing folders", async () => {
    const path = join(dir, "a", "b", "subreddits.json");
    await writeAllowlist(path, ["rust", "de"]);
    expect(await readAllowlist(path)).toEqual({ path, found: true, allow: ["rust", "de"] });
    expect(await Bun.file(path).text()).toBe('{\n  "version": 1,\n  "allow": [\n    "rust",\n    "de"\n  ]\n}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  test.each([
    ["not json", /invalid JSON/],
    ["[]", /expected a JSON object/],
    ['{"version":1,"allow":[],"extra":1}', /unknown key 'extra'/],
    ['{"version":2,"allow":[]}', /unsupported version/],
    ['{"version":1,"allow":"rust"}', /must be a list/],
    ['{"version":1,"allow":["Rust"]}', /should be written as 'rust'/],
    ['{"version":1,"allow":["all"]}', /feed/],
  ])("refuses %s", async (content, message) => {
    const path = join(dir, "subreddits.json");
    await Bun.write(path, content);
    await expect(readAllowlist(path)).rejects.toThrow(message);
  });

  test("refuses more than the maximum", async () => {
    const names = Array.from({ length: MAX_SUBREDDITS + 1 }, (_, i) => `sub_${i}`);
    await expect(writeAllowlist(join(dir, "s.json"), names)).rejects.toThrow(SubredditError);
  });
});
