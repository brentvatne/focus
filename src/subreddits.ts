import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAtomically } from "./hostsfile.ts";

/**
 * The subreddits the Chrome extension lets through while focus is on. This is the
 * extension's own state, separate from the hosts file, at a fixed path: Chrome starts
 * focus without your shell's environment, so an override would split the CLI and Chrome.
 */
export function defaultAllowlistPath(home = homedir()): string {
  return join(home, ".config", "focus", "subreddits.json");
}

/** Chrome allows 1,000 regex rules; one per subreddit stays well clear of that. */
export const MAX_SUBREDDITS = 500;

const NAME = /^[a-z0-9_]{2,21}$/;
/** Listings and feeds that look like subreddits but span many of them. */
const NOT_SUBREDDITS = new Set(["all", "popular", "random", "randnsfw", "friends", "mod", "home"]);

export class SubredditError extends Error {}

/** Accepts `rust`, `r/rust`, `/r/rust` and Reddit URLs; returns the lowercased name. */
export function normalizeSubreddit(input: string): string {
  let name = input.trim();
  if (/^[a-z]+:\/\//i.test(name) || /^([a-z0-9-]+\.)*reddit\.com\//i.test(name)) {
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(name) ? name : `https://${name}`);
    } catch {
      throw new SubredditError(`'${input}' isn't a subreddit or a Reddit URL`);
    }
    const host = url.hostname.toLowerCase();
    const sub = /^\/r\/([^/]+)/i.exec(url.pathname)?.[1];
    if (!(host === "reddit.com" || host.endsWith(".reddit.com")) || !sub) {
      throw new SubredditError(`'${input}' isn't a subreddit URL; use the subreddit's name, like 'rust'`);
    }
    name = sub;
  } else {
    name = name.replace(/^\/?r\//i, "").replace(/\/$/, "");
  }
  name = name.toLowerCase();

  if (name.includes("+")) {
    throw new SubredditError(`'${input}' combines several subreddits; allow each one separately`);
  }
  if (NOT_SUBREDDITS.has(name)) {
    throw new SubredditError(`r/${name} isn't a subreddit; it's a feed that spans all of Reddit`);
  }
  if (!NAME.test(name)) {
    throw new SubredditError(`'${input}' isn't a valid subreddit name (2-21 letters, digits or underscores)`);
  }
  return name;
}

export interface Allowlist {
  path: string;
  found: boolean;
  allow: string[];
}

/** Reads the allowlist. Refuses, rather than guesses, if the file isn't exactly what focus writes. */
export async function readAllowlist(path: string): Promise<Allowlist> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, found: false, allow: [] };
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SubredditError(`${path}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SubredditError(`${path}: expected a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "allow") {
      throw new SubredditError(`${path}: unknown key '${key}' (expected version and allow)`);
    }
  }
  const { version, allow } = raw as { version?: unknown; allow?: unknown };
  if (version !== 1) throw new SubredditError(`${path}: unsupported version ${JSON.stringify(version)}`);
  if (!Array.isArray(allow) || !allow.every((name) => typeof name === "string")) {
    throw new SubredditError(`${path}: 'allow' must be a list of subreddit names`);
  }
  for (const name of allow as string[]) {
    let normalized: string;
    try {
      normalized = normalizeSubreddit(name);
    } catch (error) {
      throw new SubredditError(`${path}: ${(error as Error).message}`);
    }
    if (normalized !== name) throw new SubredditError(`${path}: '${name}' should be written as '${normalized}'`);
  }
  if (allow.length > MAX_SUBREDDITS) {
    throw new SubredditError(`${path}: more than ${MAX_SUBREDDITS} subreddits`);
  }
  return { path, found: true, allow: [...new Set(allow as string[])] };
}

export async function writeAllowlist(path: string, allow: string[]): Promise<void> {
  if (allow.length > MAX_SUBREDDITS) {
    throw new SubredditError(`focus allows at most ${MAX_SUBREDDITS} subreddits`);
  }
  await mkdir(dirname(path), { recursive: true });
  const content = JSON.stringify({ version: 1, allow }, null, 2) + "\n";
  await writeAtomically(path, content, { mode: 0o644, uid: process.getuid!(), gid: process.getgid!() });
}
