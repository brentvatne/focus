// Stats: when focus was on, and how often Chrome tried to open a site it blocks. An
// append-only JSON Lines file, ~/.config/focus/stats.jsonl, only ever written as the user:
// by the CLI when it turns blocking on or off, and by the native host with the blocked
// pages the extension saw. Nothing here decides what's blocked; it's a history, read back
// by `focus stats`.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRESETS } from "./presets.ts";

export type BlockingState = "on" | "off";

export interface StateEvent {
  at: string;
  event: BlockingState;
  /** focus noticed the change later (made as root, or by hand), so `at` is when it noticed, not when it happened. */
  seen?: true;
}

export interface BlockedEvent {
  at: string;
  event: "blocked";
  host: string;
  /** The extension's site (youtube, reddit, …) for a page its rules blocked. */
  site?: string;
  /** Blocked by the hosts file (the whole site) or by the extension's rules (part of it). */
  mode: "whole" | "partial";
}

export type StatsEvent = StateEvent | BlockedEvent;

export function defaultStatsPath(home = homedir()): string {
  return join(home, ".config", "focus", "stats.jsonl");
}

/** Appends in one write, so lines from the CLI and the native host can't interleave. */
export async function appendEvents(path: string, events: StatsEvent[]): Promise<void> {
  if (events.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, events.map((event) => JSON.stringify(event) + "\n").join(""));
}

export async function readEvents(path: string): Promise<StatsEvent[]> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseEvents(await file.text()) : [];
}

/** Lines that aren't events (cut short by a crash, or from a newer focus) are skipped, not fatal. */
export function parseEvents(text: string): StatsEvent[] {
  const events: StatsEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isEvent(value)) events.push(value);
  }
  return events;
}

function isEvent(value: unknown): value is StatsEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) return false;
  if (event.event === "on" || event.event === "off") return true;
  return event.event === "blocked" && typeof event.host === "string" && (event.mode === "whole" || event.mode === "partial");
}

/** The last on/off the file records; the file is in order for these, as only the CLI writes them. */
export function lastState(events: StatsEvent[]): BlockingState | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.event !== "blocked") return event.event;
  }
  return null;
}

export interface Session {
  start: number;
  /** null while it's still on. */
  end: number | null;
  /** The start or end is only when focus noticed it, so the length isn't known exactly. */
  inexact: boolean;
}

export function sessionsOf(events: StatsEvent[]): Session[] {
  const sessions: Session[] = [];
  let open: { start: number; seen: boolean } | null = null;
  for (const event of events) {
    if (event.event === "blocked") continue;
    const at = Date.parse(event.at);
    if (event.event === "on" && !open) open = { start: at, seen: event.seen === true };
    if (event.event === "off" && open) {
      sessions.push({ start: open.start, end: at, inexact: open.seen || event.seen === true });
      open = null;
    }
  }
  if (open) sessions.push({ start: open.start, end: null, inexact: open.seen });
  return sessions;
}

export interface DayStats {
  /** Local midnight. */
  start: number;
  onMs: number;
  /** Sessions that started this day. */
  sessions: number;
  /** Times focus was turned on or off. */
  toggles: number;
  blocked: number;
}

export interface Summary {
  now: number;
  state: BlockingState | null;
  /** When the current session started, while on. */
  onSince: number | null;
  /** Newest first, `days` of them, today first. */
  days: DayStats[];
  total: { onMs: number; sessions: number; toggles: number; blocked: number };
  /** Over finished sessions with exact times. */
  averageMs: number | null;
  longestMs: number | null;
  /** Most blocked first. */
  sites: { name: string; count: number }[];
  /** Anything recorded at all. */
  empty: boolean;
}

export function summarize(events: StatsEvent[], now: number, dayCount: number): Summary {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const sessions = sessionsOf(sorted);
  const today = startOfDay(now);
  const days: DayStats[] = [];
  for (let index = 0; index < dayCount; index++) {
    const start = addDays(today, -index);
    days.push({ start, onMs: 0, sessions: 0, toggles: 0, blocked: 0 });
  }
  const from = days[days.length - 1]!.start;
  const dayOf = (at: number) => days.find((day) => at >= day.start && at < addDays(day.start, 1));

  for (const session of sessions) {
    const end = session.end ?? now;
    for (const day of days) {
      day.onMs += Math.max(0, Math.min(end, addDays(day.start, 1)) - Math.max(session.start, day.start));
    }
    const day = dayOf(session.start);
    if (day) day.sessions++;
  }
  const counts = new Map<string, number>();
  for (const event of sorted) {
    const at = Date.parse(event.at);
    const day = dayOf(at);
    if (!day) continue;
    if (event.event === "blocked") {
      day.blocked++;
      const name = siteName(event);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    } else if (!event.seen) {
      day.toggles++;
    }
  }

  const finished = sessions
    .filter((session) => session.end !== null && !session.inexact && session.start >= from)
    .map((session) => session.end! - session.start);
  const state = lastState(sorted);
  const current = sessions.at(-1);
  return {
    now,
    state,
    onSince: state === "on" && current && current.end === null ? current.start : null,
    days,
    total: {
      onMs: sum(days.map((day) => day.onMs)),
      sessions: sum(days.map((day) => day.sessions)),
      toggles: sum(days.map((day) => day.toggles)),
      blocked: sum(days.map((day) => day.blocked)),
    },
    averageMs: finished.length > 0 ? sum(finished) / finished.length : null,
    longestMs: finished.length > 0 ? Math.max(...finished) : null,
    sites: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    empty: events.length === 0,
  };
}

/** The preset a host belongs to, by name, or the host itself without `www.`. */
export function siteName(event: BlockedEvent): string {
  const byHost = PRESETS.find((preset) => preset.hosts.includes(event.host));
  const bySite = event.site ? PRESETS.find((preset) => preset.id === event.site) : undefined;
  return (byHost ?? bySite)?.name ?? event.host.replace(/^www\./, "");
}

export function formatSummary(summary: Summary, options: { inChrome: boolean }): string {
  if (summary.empty) {
    return (
      "No stats yet. focus records each time you turn it on or off from here on" +
      (options.inChrome ? ", and each time Chrome tries to open a site it blocks.\n" : ".\n")
    );
  }
  const lines: string[] = [];
  if (summary.onSince !== null) {
    lines.push(`focus is on, for ${duration(summary.now - summary.onSince)} (since ${clock(summary.onSince, summary.now)})`, "");
  } else if (summary.state === "off") {
    lines.push("focus is off", "");
  }
  const rows: string[][] = summary.days.map((day, index) => [
    index === 0 ? "Today" : index === 1 ? "Yesterday" : dayName(day.start),
    day.onMs > 0 ? duration(day.onMs) : "–",
    String(day.sessions),
    String(day.toggles),
    String(day.blocked),
  ]);
  const total = ["Total", duration(summary.total.onMs), ...[summary.total.sessions, summary.total.toggles, summary.total.blocked].map(String)];
  const header = ["", "On for", "Sessions", "Toggled", "Blocked"];
  const widths = header.map((_, column) => Math.max(...[header, ...rows, total].map((row) => row[column]!.length)));
  const render = (row: string[]) =>
    row.map((cell, column) => (column === 0 ? cell.padEnd(widths[0]!) : cell.padStart(widths[column]!))).join("   ").trimEnd();
  lines.push(render(header), ...rows.map(render), render(total));
  if (summary.averageMs !== null) {
    lines.push("", `Sessions: average ${duration(summary.averageMs)}, longest ${duration(summary.longestMs!)}`);
  }
  if (summary.sites.length > 0) {
    lines.push("", "Blocked most:");
    const width = Math.max(...summary.sites.slice(0, 8).map((site) => site.name.length));
    for (const site of summary.sites.slice(0, 8)) lines.push(`  ${site.name.padEnd(width)}  ${String(site.count).padStart(4)}`);
  }
  if (!options.inChrome) {
    lines.push("", "Blocked counts come from the Chrome extension; `focus chrome install` sets it up.");
  }
  return lines.join("\n") + "\n";
}

/** "2h 05m", "45m", "under a minute". */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

function clock(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return startOfDay(at) === startOfDay(now) ? time : `${dayName(at)}, ${time}`;
}

function dayName(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** By calendar day, so days with a daylight-saving change still line up with midnight. */
function addDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
