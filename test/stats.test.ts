import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StatsEvent, appendEvents, duration, formatSummary, parseEvents, readEvents, sessionsOf, summarize } from "../src/stats.ts";

// Days are local, so pin the zone; this one has a daylight-saving change on 2026-11-01.
process.env.TZ = "America/New_York";

/** A local time on a day in October 2026. */
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();
const iso = (time: number) => new Date(time).toISOString();
const on = (time: number, seen = false): StatsEvent => ({ at: iso(time), event: "on", ...(seen ? { seen: true as const } : {}) });
const off = (time: number, seen = false): StatsEvent => ({ at: iso(time), event: "off", ...(seen ? { seen: true as const } : {}) });
const blocked = (time: number, host: string, site?: string): StatsEvent => ({
  at: iso(time),
  event: "blocked",
  host,
  ...(site ? { site } : {}),
  mode: site ? "partial" : "whole",
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "focus-stats-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("appends events as lines and reads them back, skipping lines that aren't events", async () => {
  const path = join(dir, "nested", "stats.jsonl");
  await appendEvents(path, [on(at(16, 9))]);
  await appendEvents(path, [blocked(at(16, 10), "x.com")]);
  expect(await readEvents(path)).toEqual([on(at(16, 9)), blocked(at(16, 10), "x.com")]);
  expect(await readEvents(join(dir, "missing.jsonl"))).toEqual([]);
  expect(parseEvents(`{"at":"2026-10-16T00:00:00Z","event":"on"}\n{"at":"2026-10-16T0\nnot json\n{"event":"on"}\n{"at":"x","event":"off"}\n`)).toEqual([
    { at: "2026-10-16T00:00:00Z", event: "on" },
  ]);
});

test("pairs on and off into sessions, ignoring repeats; the last may still be running", () => {
  expect(sessionsOf([on(at(16, 9)), on(at(16, 9, 30)), off(at(16, 11)), off(at(16, 12)), on(at(16, 13))])).toEqual([
    { start: at(16, 9), end: at(16, 11), inexact: false },
    { start: at(16, 13), end: null, inexact: false },
  ]);
  expect(sessionsOf([on(at(16, 9), true), off(at(16, 11))])[0]!.inexact).toBe(true);
});

test("adds up each day: time on (split at midnight), sessions, toggles and blocked pages", () => {
  const now = at(16, 15);
  const summary = summarize(
    [
      on(at(14, 22)),
      off(at(15, 1)), // 2h on the 14th, 1h on the 15th
      on(at(15, 9)),
      off(at(15, 12)),
      on(at(16, 9)), // still on: 6h so far today
      blocked(at(16, 10), "www.youtube.com", "youtube"),
      blocked(at(16, 11), "youtube.com", "youtube"),
      blocked(at(16, 12), "x.com"),
      blocked(at(15, 10), "news.example.com"),
      blocked(at(1, 10), "x.com"), // before the range
    ],
    now,
    3,
  );
  expect(summary.days.map(({ onMs, sessions, toggles, blocked }) => ({ hours: onMs / 3_600_000, sessions, toggles, blocked }))).toEqual([
    { hours: 6, sessions: 1, toggles: 1, blocked: 3 },
    { hours: 4, sessions: 1, toggles: 3, blocked: 1 },
    { hours: 2, sessions: 1, toggles: 1, blocked: 0 },
  ]);
  expect(summary.total).toEqual({ onMs: 12 * 3_600_000, sessions: 3, toggles: 5, blocked: 4 });
  expect(summary.onSince).toBe(at(16, 9));
  // Finished sessions only: 3h and 3h.
  expect(summary.averageMs).toBe(3 * 3_600_000);
  expect(summary.longestMs).toBe(3 * 3_600_000);
  expect(summary.sites).toEqual([
    { name: "YouTube", count: 2 },
    { name: "news.example.com", count: 1 },
    { name: "X / Twitter", count: 1 },
  ]);
});

test("changes focus only noticed later count toward time on but not session lengths or toggles", () => {
  const summary = summarize([on(at(16, 8), true), off(at(16, 10)), on(at(16, 11)), off(at(16, 12))], at(16, 15), 1);
  expect(summary.days[0]!.onMs).toBe(3 * 3_600_000);
  expect(summary.days[0]!.toggles).toBe(3);
  expect(summary.averageMs).toBe(3_600_000);
});

test("days follow the calendar across a daylight-saving change", () => {
  // Nov 1 2026 is 25 hours long in New York.
  const now = new Date(2026, 10, 2, 12).getTime();
  const summary = summarize([on(new Date(2026, 10, 1, 0).getTime()), off(new Date(2026, 10, 2, 0).getTime())], now, 2);
  expect(summary.days[1]!.onMs).toBe(25 * 3_600_000);
  expect(summary.days[0]!.onMs).toBe(0);
});

test("formats a table of days, session lengths and the most blocked sites", () => {
  const summary = summarize(
    [on(at(15, 9)), off(at(15, 12, 30)), on(at(16, 9)), blocked(at(16, 10), "www.youtube.com", "youtube"), blocked(at(16, 11), "x.com")],
    at(16, 10, 15),
    3,
  );
  expect(formatSummary(summary, { inChrome: true })).toBe(
    [
      "focus is on, for 1h 15m (since 9:00 AM)",
      "",
      "              On for   Sessions   Toggled   Blocked",
      "Today         1h 15m          1         1         2",
      "Yesterday     3h 30m          1         2         0",
      "Wed, Oct 14        –          0         0         0",
      "Total         4h 45m          2         3         2",
      "",
      "Sessions: average 3h 30m, longest 3h 30m",
      "",
      "Blocked most:",
      "  X / Twitter     1",
      "  YouTube         1",
      "",
    ].join("\n"),
  );
});

test("says how stats work before there are any, and where blocked counts come from", () => {
  expect(formatSummary(summarize([], at(16, 9), 7), { inChrome: false })).toBe(
    "No stats yet. focus records each time you turn it on or off from here on.\n",
  );
  const text = formatSummary(summarize([off(at(16, 9))], at(16, 10), 7), { inChrome: false });
  expect(text).toStartWith("focus is off\n");
  expect(text).toContain("`focus chrome install`");
});

test("durations", () => {
  expect(duration(20_000)).toBe("<1m");
  expect(duration(45 * 60_000)).toBe("45m");
  expect(duration(125 * 60_000)).toBe("2h 05m");
});
