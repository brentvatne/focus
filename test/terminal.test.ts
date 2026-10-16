import { expect, test } from "bun:test";
import { fileUrl, hyperlink, styles, supportsHyperlinks } from "../src/terminal.ts";

test.each([
  [{ TERM_PROGRAM: "iTerm.app" }, true, true],
  [{ TERM_PROGRAM: "ghostty" }, true, true],
  [{ TERM_PROGRAM: "WezTerm" }, true, true],
  [{ TERM_PROGRAM: "vscode" }, true, true],
  [{ TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2" }, true, true],
  [{ TERM: "xterm-kitty" }, true, true],
  [{ TERM_PROGRAM: "Apple_Terminal" }, true, false],
  [{ TERM_PROGRAM: "iTerm.app" }, false, false],
  [{ TERM_PROGRAM: "iTerm.app", CI: "true" }, true, false],
  [{ TERM_PROGRAM: "iTerm.app", FORCE_HYPERLINK: "0" }, true, false],
  [{ FORCE_HYPERLINK: "1" }, false, true],
] as const)("supportsHyperlinks(%o, terminal: %p) is %p", (env, isTerminal, expected) => {
  expect(supportsHyperlinks(env, isTerminal)).toBe(expected);
});

test("hyperlink wraps text in OSC 8 only when enabled", () => {
  expect(hyperlink("guide", "https://example.com", true)).toBe("\x1b]8;;https://example.com\x1b\\guide\x1b]8;;\x1b\\");
  expect(hyperlink("guide", "https://example.com", false)).toBe("guide");
});

test("fileUrl escapes each part of the path", () => {
  expect(fileUrl("/Users/me/Library/Application Support/focus")).toBe("file:///Users/me/Library/Application%20Support/focus");
});

test("styles are plain without color", () => {
  expect(styles(false).bold("x")).toBe("x");
  expect(styles(true).bold("x")).toBe("\x1b[1mx\x1b[22m");
});
