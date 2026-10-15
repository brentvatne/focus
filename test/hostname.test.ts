import { describe, expect, test } from "bun:test";
import { InvalidHostnameError, normalizeHostname } from "../src/hostname.ts";

describe("normalizeHostname", () => {
  test.each([
    ["youtube.com", "youtube.com"],
    ["  News.YCombinator.com  ", "news.ycombinator.com"],
    ["reddit.com.", "reddit.com"],
    ["xn--bcher-kva.de", "xn--bcher-kva.de"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["a-b.co.uk", "a-b.co.uk"],
    ["123.example.com", "123.example.com"],
  ])("accepts %p as %p", (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  test.each([
    ["", /empty/],
    ["localhost", /must include a domain/],
    ["youtube", /must include a domain/],
    ["foo.localhost", /reserved/],
    ["printer.local", /reserved/],
    ["localhost.localdomain", /reserved/],
    ["1.2.3.4", /IP addresses/],
    ["::1", /IP addresses/],
    ["fe80::1", /IP addresses/],
    ["https://www.youtube.com/watch?v=x", /Did you mean 'www.youtube.com'/],
    ["youtube.com/feed", /Did you mean 'youtube.com'/],
    ["youtube.com:443", /Did you mean 'youtube.com'/],
    ["*.youtube.com", /wildcards/],
    ["-bad.com", /can't start or end with a hyphen/],
    ["bad-.com", /can't start or end with a hyphen/],
    ["a..com", /empty label/],
    [".example.com", /empty label/],
    ["under_score.com", /letters, digits or hyphens/],
    ["you tube.com", /characters that aren't allowed/],
    [`${"a".repeat(64)}.com`, /1-63/],
    [`${"a.".repeat(127)}com`, /253/],
  ])("rejects %p", (input, message) => {
    expect(() => normalizeHostname(input)).toThrow(InvalidHostnameError);
    expect(() => normalizeHostname(input)).toThrow(message);
  });
});
