import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAtomically } from "./hostsfile.ts";

/**
 * Sites the Chrome extension can block only the feed of, while focus is on: the pages that
 * serve an endless stream go, and direct links (a video, a post) still load. `preset` is the
 * hosts-file preset that blocks the whole site instead.
 */
export const FEED_SITES = [
  { id: "youtube", name: "YouTube", preset: "youtube", what: "the home page, Shorts and Explore, and recommendations on video pages" },
  { id: "x", name: "X", preset: "x", what: "the Home timeline, Explore, search and notifications" },
] as const;

export type FeedSiteId = (typeof FEED_SITES)[number]["id"];
export type FeedSite = (typeof FEED_SITES)[number];

export function findFeedSite(id: string): FeedSite | undefined {
  return FEED_SITES.find((site) => site.id === id.toLowerCase());
}

/** Where the feed-only sites are listed. A fixed path, like the subreddit allowlist, for the same reason. */
export function defaultFeedsPath(home = homedir()): string {
  return join(home, ".config", "focus", "feeds.json");
}

export class FeedsError extends Error {}

/** Reads the feed-only sites; none when the file doesn't exist. Refuses a file focus didn't write. */
export async function readFeeds(path: string): Promise<FeedSiteId[]> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new FeedsError(`${path}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new FeedsError(`${path}: expected a JSON object`);
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "feeds") throw new FeedsError(`${path}: unknown key '${key}' (expected version and feeds)`);
  }
  const { version, feeds } = raw as { version?: unknown; feeds?: unknown };
  if (version !== 1) throw new FeedsError(`${path}: unsupported version ${JSON.stringify(version)}`);
  if (!Array.isArray(feeds) || !feeds.every((id) => typeof id === "string" && FEED_SITES.some((site) => site.id === id))) {
    throw new FeedsError(`${path}: 'feeds' must be a list of ${FEED_SITES.map((site) => site.id).join(", ")}`);
  }
  // In catalog order, so the rules and the output never depend on the order they were added.
  return FEED_SITES.map((site) => site.id).filter((id) => feeds.includes(id));
}

export async function writeFeeds(path: string, feeds: FeedSiteId[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const ordered = FEED_SITES.map((site) => site.id).filter((id) => feeds.includes(id));
  const content = JSON.stringify({ version: 1, feeds: ordered }, null, 2) + "\n";
  await writeAtomically(path, content, { mode: 0o644, uid: process.getuid!(), gid: process.getgid!() });
}
