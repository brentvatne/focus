import { InvalidHostnameError, normalizeHostname } from "./hostname.ts";

export const BEGIN_MARKER = "# BEGIN focus";
export const END_MARKER = "# END focus";
export const BLOCK_IPV4 = "0.0.0.0";
export const BLOCK_IPV6 = "::";

export type BlockState = "on" | "off";

/** Everything focus owns in the hosts file. Lines outside the section are never touched. */
export interface FocusSection {
  state: BlockState;
  hosts: string[];
}

export class HostsFormatError extends Error {}

const STATE_LINE = /^#\s*state:\s*(on|off)$/;
const ENTRY_LINE = /^(#\s*)?(0\.0\.0\.0|::)\s+(\S+)$/;

interface LocatedSection extends FocusSection {
  /** Line index of BEGIN_MARKER. */
  start: number;
  /** Line index of END_MARKER. */
  end: number;
  crlf: boolean;
}

/** Returns the focus section of a hosts file, or null if there isn't one. */
export function readSection(content: string): FocusSection | null {
  const located = locateSection(content.split("\n"));
  return located && { state: located.state, hosts: located.hosts };
}

/**
 * Returns `content` with the focus section replaced by `next`. Passing null or a
 * section with no hosts removes the section entirely, restoring the original file.
 */
export function writeSection(content: string, next: FocusSection | null): string {
  const lines = content.split("\n");
  const located = locateSection(lines);
  const empty = next === null || next.hosts.length === 0;

  if (located) {
    const replacement = empty ? [] : renderSection(next, located.crlf);
    lines.splice(located.start, located.end - located.start + 1, ...replacement);
    return lines.join("\n");
  }
  if (empty) return content;

  const crlf = content.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const block = renderSection(next, crlf).join("\n") + "\n";
  if (content === "") return block;
  return content.endsWith("\n") ? content + block : content + eol + block;
}

export function renderSection(section: FocusSection, crlf = false): string[] {
  const prefix = section.state === "on" ? "" : "# ";
  const lines = [
    BEGIN_MARKER,
    "# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.",
    `# state: ${section.state}`,
    ...section.hosts.flatMap((host) => [`${prefix}${BLOCK_IPV4} ${host}`, `${prefix}${BLOCK_IPV6} ${host}`]),
    END_MARKER,
  ];
  return crlf ? lines.map((line) => line + "\r") : lines;
}

function locateSection(lines: string[]): LocatedSection | null {
  const trimmed = lines.map((line) => line.trim());
  const begins = indicesOf(trimmed, BEGIN_MARKER);
  const ends = indicesOf(trimmed, END_MARKER);

  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length > 1 || ends.length > 1) {
    throw new HostsFormatError(`Found more than one '${BEGIN_MARKER}' or '${END_MARKER}' line.`);
  }
  const start = begins[0];
  const end = ends[0];
  if (start === undefined || end === undefined || end < start) {
    throw new HostsFormatError(`'${BEGIN_MARKER}' and '${END_MARKER}' must both appear, in that order.`);
  }

  let state: BlockState | null = null;
  let anyActive = false;
  const hosts: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const line = trimmed[i]!;
    const stateMatch = STATE_LINE.exec(line);
    const entryMatch = ENTRY_LINE.exec(line);
    if (stateMatch) {
      state = stateMatch[1] as BlockState;
    } else if (entryMatch) {
      const host = parseHost(entryMatch[3]!, i);
      if (!hosts.includes(host)) hosts.push(host);
      if (!entryMatch[1]) anyActive = true;
    } else if (line !== "" && !line.startsWith("#")) {
      throw new HostsFormatError(`Unexpected line ${i + 1} inside the focus section: '${line}'`);
    }
  }

  return {
    start,
    end,
    state: state ?? (anyActive ? "on" : "off"),
    hosts,
    crlf: lines[start]!.endsWith("\r"),
  };
}

function parseHost(value: string, index: number): string {
  try {
    return normalizeHostname(value);
  } catch (error) {
    if (error instanceof InvalidHostnameError) {
      throw new HostsFormatError(`Line ${index + 1} inside the focus section: ${error.message}`);
    }
    throw error;
  }
}

function indicesOf(lines: string[], value: string): number[] {
  return lines.flatMap((line, i) => (line === value ? [i] : []));
}
