import { Prompt, isAccessible } from "@clack/core";
import { isCancel, select, text } from "@clack/prompts";
import type { Readable, Writable } from "node:stream";

/** How much of a site focus blocks. "partial" is the site's Chrome option, when it has one. */
export type Mode = "off" | "whole" | "partial";

export interface SiteRow {
  id: string;
  name: string;
  /** The modes this row offers, in order, each with what it means. */
  modes: { mode: Mode; label: string; detail: string }[];
  /** A dim line under the focused row: the hostnames it covers. */
  hosts: string;
  /** Shown under the focused row too, for something worth knowing about its current state. */
  note?: string;
}

export interface SitesChoice {
  values: Record<string, Mode>;
  /** The "Add a site" row was chosen; ask for a hostname and come back. */
  add: boolean;
}

export interface SitesOptions {
  message: string;
  /** A dim line above the rows, such as whether focus is on. */
  header?: string;
  /** The row the cursor starts on. */
  focus?: string;
  input?: Readable;
  output?: Writable;
}

const ADD = "\0add";

/**
 * One row per site, each set to one of its modes: ←/→ (or 1, 2, 3) picks the mode of the
 * focused row, which also shows what that mode does and the hostnames involved. The last
 * row adds a site. Screen readers get one question per site instead (ACCESSIBLE=1).
 */
export async function chooseSites(rows: SiteRow[], initial: Record<string, Mode>, options: SitesOptions): Promise<SitesChoice | null> {
  if (isAccessible()) return chooseSitesOneByOne(rows, initial, options);
  const prompt = new SitesPrompt(rows, initial, options);
  const result = await prompt.prompt();
  if (isCancel(result) || result === undefined) return null;
  return { values: result, add: prompt.cursorRow === ADD };
}

class SitesPrompt extends Prompt<Record<string, Mode>> {
  cursorRow: string;

  constructor(rows: SiteRow[], initial: Record<string, Mode>, options: SitesOptions) {
    const ids = [...rows.map((row) => row.id), ADD];
    super({
      input: options.input,
      output: options.output,
      render() {
        const self = this as unknown as SitesPrompt;
        return renderSites(rows, self.value ?? initial, self.cursorRow, self.state, options, (self.output as { columns?: number }).columns ?? 80);
      },
    });
    this.value = { ...initial };
    this.cursorRow = options.focus && ids.includes(options.focus) ? options.focus : ids[0]!;

    const move = (by: number) => {
      this.cursorRow = ids[(ids.indexOf(this.cursorRow) + by + ids.length) % ids.length]!;
    };
    // Clamped at the ends, so holding an arrow can't wrap past the mode you wanted.
    const setMode = (pick: (index: number, count: number) => number) => {
      const row = rows.find((candidate) => candidate.id === this.cursorRow);
      if (!row) return;
      const index = row.modes.findIndex((option) => option.mode === this.value![row.id]);
      const next = row.modes[pick(Math.max(index, 0), row.modes.length)];
      if (next) this.value = { ...this.value!, [row.id]: next.mode };
    };
    this.on("cursor", (action) => {
      if (action === "up") move(-1);
      if (action === "down") move(1);
      if (action === "left") setMode((index) => Math.max(index - 1, 0));
      if (action === "right") setMode((index, count) => Math.min(index + 1, count - 1));
      if (action === "space") setMode((index, count) => (index + 1) % count);
    });
    this.on("key", (char) => {
      const digit = Number(char);
      if (Number.isInteger(digit) && digit >= 1) setMode(() => digit - 1);
    });
  }
}

/** Plain-text frame of the sites list; exported for tests. */
export function renderSites(
  rows: SiteRow[],
  values: Record<string, Mode>,
  cursor: string,
  state: string,
  options: SitesOptions,
  columns: number,
): string {
  const done = state === "submit" || state === "cancel";
  const bar = done ? gray("│") : cyan("│");
  if (done) {
    const summary = state === "cancel" ? gray("Cancelled") : gray(cursor === ADD ? "Adding a site…" : "Done");
    return `${gray("◇")}  ${options.message}\n${bar}  ${summary}`;
  }
  // Narrow terminals show every mode only on the focused row.
  const compact = columns < 76;
  // Names line up in a column as wide as the longest (your own sites can be long), within reason.
  const width = Math.min(Math.max(11, ...rows.map((row) => row.name.length)), 24) + 2;
  const lines = [`${cyan("◆")}  ${options.message}`];
  if (options.header) lines.push(`${bar}  ${gray(options.header)}`);
  lines.push(bar);
  for (const row of rows) {
    const focused = row.id === cursor;
    const value = values[row.id] ?? "off";
    const name = row.name.length > width - 2 ? `${row.name.slice(0, width - 3)}…` : row.name;
    const label = (focused ? bold : (text: string) => text)(name.padEnd(width - 2));
    const segments =
      compact && !focused
        ? labelOf(row, value)
        : row.modes
            .map((option, index) =>
              option.mode === value
                ? green(`● ${option.label}`)
                : gray(`○ ${focused && row.modes.length > 1 ? `${index + 1} ` : ""}${option.label}`),
            )
            .join("  ");
    lines.push(`${bar} ${focused ? cyan("›") : " "} ${label}  ${segments}`);
    if (focused) {
      const detail = row.modes.find((option) => option.mode === value)?.detail ?? "";
      for (const extra of [detail, row.note, row.hosts]) {
        if (extra) lines.push(`${bar}   ${" ".repeat(width)}${gray(extra)}`);
      }
    }
  }
  const adding = cursor === ADD;
  lines.push(`${bar} ${adding ? cyan("›") : " "} ${adding ? bold("+ Add a site…") : gray("+ Add a site…")}`);
  lines.push(bar, `${cyan("└")}  ${gray(adding ? "Enter: add a site · Esc: cancel" : "↑/↓ site · ←/→ or 1-3 mode · Enter: done · Esc: cancel")}`);
  return lines.join("\n");
}

function labelOf(row: SiteRow, mode: Mode): string {
  const option = row.modes.find((candidate) => candidate.mode === mode);
  return mode === "off" ? gray(option?.label ?? "off") : green(option?.label ?? mode);
}

/** The same choices as plain questions, one site at a time, for screen readers. */
async function chooseSitesOneByOne(rows: SiteRow[], initial: Record<string, Mode>, options: SitesOptions): Promise<SitesChoice | null> {
  const values = { ...initial };
  for (const row of rows) {
    const result = await select({
      message: `${options.message} ${row.name}`,
      options: row.modes.map((option) => ({ value: option.mode, label: option.label, hint: option.detail })),
      initialValue: values[row.id] ?? "off",
    });
    if (isCancel(result)) return null;
    values[row.id] = result;
  }
  const more = await select({
    message: "Add another site?",
    options: [
      { value: false, label: "No, done" },
      { value: true, label: "Yes, add a site" },
    ],
  });
  if (isCancel(more)) return null;
  return { values, add: more };
}

/** One line of text; null if cancelled. */
export async function askText(message: string, placeholder: string): Promise<string | null> {
  const result = await text({ message, placeholder });
  return isCancel(result) ? null : (result ?? "");
}

const color = (open: number, close: number) => (text: string) =>
  process.env.NO_COLOR ? text : `\x1b[${open}m${text}\x1b[${close}m`;
const cyan = color(36, 39);
const green = color(32, 39);
const gray = color(90, 39);
const bold = color(1, 22);
