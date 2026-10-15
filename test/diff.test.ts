import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../src/diff.ts";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("unifiedDiff", () => {
  test("returns an empty string for identical input", () => {
    expect(unifiedDiff("a\n", "a\n", "x", "y")).toBe("");
  });

  test("shows an append with three lines of context", () => {
    expect(unifiedDiff(numbered(10), numbered(10) + "new\n", "before", "after")).toBe(
      ["--- before", "+++ after", "@@ -8,3 +8,4 @@", " line 8", " line 9", " line 10", "+new", ""].join("\n"),
    );
  });

  test("shows a change in the middle", () => {
    const after = numbered(10).replace("line 5\n", "line five\n");
    expect(unifiedDiff(numbered(10), after, "a", "b")).toBe(
      [
        "--- a",
        "+++ b",
        "@@ -2,7 +2,7 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+line five",
        " line 6",
        " line 7",
        " line 8",
        "",
      ].join("\n"),
    );
  });

  test("splits distant changes into separate hunks", () => {
    const after = numbered(30).replace("line 2\n", "two\n").replace("line 25\n", "twenty-five\n");
    const headers = unifiedDiff(numbered(30), after, "a", "b").split("\n").filter((l) => l.startsWith("@@"));
    expect(headers).toEqual(["@@ -1,5 +1,5 @@", "@@ -22,7 +22,7 @@"]);
  });

  test("diffs into and out of an empty file", () => {
    expect(unifiedDiff("", "a\nb\n", "a", "b")).toBe("--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(unifiedDiff("a\nb\n", "", "a", "b")).toBe("--- a\n+++ b\n@@ -1,2 +0,0 @@\n-a\n-b\n");
  });

  test("marks a missing trailing newline", () => {
    expect(unifiedDiff("a", "a\nb\n", "x", "y")).toBe(
      "--- x\n+++ y\n@@ -1 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n+b\n",
    );
  });
});
