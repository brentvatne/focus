import { describe, expect, test } from "bun:test";
import { UNKNOWN_POLICY, buildRules, evaluate, isAllowed, isBareComments, mayStay, subredditOf } from "../extension/rules.js";
import { MAX_SUBREDDITS } from "../src/subreddits.ts";

const on = { state: "on" as const, allow: ["rust", "de"] };

describe("isAllowed while focus is on", () => {
  test.each([
    "https://www.reddit.com/r/rust/",
    "https://www.reddit.com/r/rust",
    "https://reddit.com/r/rust/comments/abc123/some_title/",
    "https://old.reddit.com/r/RUST/top/?t=week",
    "https://new.reddit.com/r/rust#hash",
    "https://np.reddit.com/r/rust/",
    "https://sh.reddit.com/r/rust/",
    "https://www.reddit.com/r/rust/s/AbCdEf",
    "https://www.reddit.com/r/de/",
    "https://www.reddit.com/login/",
    "https://www.reddit.com/register",
    "https://out.reddit.com/t3_abc?url=https%3A%2F%2Fexample.com",
    "https://www.reddit.com/comments/abc123",
    "https://redd.it/abc123",
  ])("allows %s", (url) => {
    expect(isAllowed(on, url)).toBe(true);
  });

  test.each([
    "https://www.reddit.com/",
    "https://reddit.com",
    "https://www.reddit.com/r/rustjerk/",
    "https://www.reddit.com/r/rust+pics/",
    "https://www.reddit.com/r/all/",
    "https://www.reddit.com/r/popular",
    "https://www.reddit.com/user/someone",
    "https://www.reddit.com/search/?q=rust",
    "https://www.reddit.com/r/rust/search/?q=x&restrict_sr=off",
    "https://old.reddit.com/r/rust/search?q=x",
    "https://amp.reddit.com/r/pics/",
    "https://m.reddit.com/",
    "https://www.reddit.com/media?url=x",
  ])("blocks %s", (url) => {
    expect(isAllowed(on, url)).toBe(false);
  });

  test.each([
    "https://evilreddit.com/r/pics",
    "https://reddit.com.example.com/",
    "https://i.redd.it/abc.jpg",
    "https://v.redd.it/abc/DASH_720.mp4",
    "https://preview.redd.it/abc.png",
    "https://www.redditmedia.com/mediaembed/abc",
    "https://www.redditstatic.com/shreddit/x.js",
    "https://www.messenger.com/",
  ])("never matches %s", (url) => {
    expect(evaluate(buildRules(on), url, "main_frame")).toBeNull();
    expect(evaluate(buildRules(on), url, "sub_frame")).toBeNull();
  });

  test("bare /comments/<id> is allowed as a page but not as a frame", () => {
    const rules = buildRules(on);
    expect(evaluate(rules, "https://www.reddit.com/comments/abc123", "main_frame")).toBe("allow");
    expect(evaluate(rules, "https://www.reddit.com/comments/abc123", "sub_frame")).toBe("block");
  });
});

describe("buildRules", () => {
  test("is empty while focus is off or nothing is listed", () => {
    expect(buildRules({ state: "off", allow: ["rust"] })).toEqual([]);
    expect(buildRules({ state: "none", allow: ["rust"] })).toEqual([]);
    expect(isAllowed({ state: "off", allow: [] }, "https://www.reddit.com/")).toBe(true);
  });

  test("blocks everything but the fixed exceptions before focus has answered", () => {
    expect(isAllowed(UNKNOWN_POLICY, "https://www.reddit.com/r/rust/")).toBe(false);
    expect(isAllowed(UNKNOWN_POLICY, "https://www.reddit.com/login")).toBe(true);
  });

  test("ids are unique and the largest allowlist stays under Chrome's 1,000 regex rules", () => {
    const allow = Array.from({ length: MAX_SUBREDDITS }, (_, i) => `sub_${i}`);
    const rules = buildRules({ state: "on", allow });
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    expect(rules.filter((rule) => rule.condition.regexFilter).length).toBeLessThan(1000);
  });

  test("regexes stay within RE2 and Chrome's 2 KB per rule", () => {
    for (const rule of buildRules({ state: "on", allow: ["a_very_long_name_21ch"] })) {
      const regex = rule.condition.regexFilter;
      if (!regex) continue;
      expect(regex).not.toMatch(/\(\?|\\[1-9]/); // no lookarounds, named groups or backreferences
      expect(regex.length).toBeLessThan(2048);
    }
  });
});

test("mayStay uses the subreddit a bare comments page reported", () => {
  const post = "https://www.reddit.com/comments/abc123";
  expect(mayStay(on, post, "rust")).toBe(true);
  expect(mayStay(on, post, "Pics")).toBe(false);
  expect(mayStay(on, post, null)).toBe(false);
  expect(mayStay({ state: "off", allow: [] }, post, null)).toBe(true);
  expect(mayStay(on, "https://www.reddit.com/r/rust/", null)).toBe(true);
  expect(mayStay(on, "https://www.reddit.com/r/pics/", "rust")).toBe(false);
  expect(isBareComments(post)).toBe(true);
  expect(isBareComments("https://www.reddit.com/r/rust/comments/abc123")).toBe(false);
});

test("subredditOf", () => {
  expect(subredditOf("https://www.reddit.com/r/Rust/comments/x")).toBe("rust");
  expect(subredditOf("https://www.reddit.com/user/x")).toBeNull();
  expect(subredditOf("not a url")).toBeNull();
});
