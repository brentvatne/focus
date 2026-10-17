// focus as the Chrome extension's native-messaging host. Chrome starts the binary with
// the extension's origin as its argument, sends one message on stdin and waits for one
// reply on stdout. The host reads the hosts file's state, the subreddit allowlist and
// the feeds. It writes only two things: the extension's own folder after an upgrade, and
// the blocked pages the extension reports, appended to the stats file.
import { PROTOCOL } from "../extension/rules.js";
import { isDirectory, writeExtension } from "./chrome.ts";
import { type FocusSection, HostsFormatError, readSection } from "./hosts.ts";
import { readHostsFile } from "./hostsfile.ts";
import { FEED_SITES, readFeeds } from "./feeds.ts";
import { type BlockedEvent, appendEvents } from "./stats.ts";
import { readAllowlist } from "./subreddits.ts";

/** Chrome's limit for a message from the host; requests are far smaller. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export class NativeMessageError extends Error {}

/** A message: its length as a 32-bit little-endian integer (native order on arm64), then UTF-8 JSON. */
export function encodeMessage(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  if (body.length > MAX_MESSAGE_BYTES) throw new NativeMessageError(`reply is ${body.length} bytes; Chrome accepts 1 MB`);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, 4);
  return frame;
}

/** Reads exactly one message. Chrome doesn't close stdin until it has the reply, so this can't wait for EOF. */
export async function readMessage(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
  let buffered = new Uint8Array(0);
  let length: number | null = null;
  for await (const chunk of chunks) {
    const next = new Uint8Array(buffered.length + chunk.length);
    next.set(buffered);
    next.set(chunk, buffered.length);
    buffered = next;
    if (length === null && buffered.length >= 4) {
      length = new DataView(buffered.buffer, buffered.byteOffset).getUint32(0, true);
      if (length > MAX_MESSAGE_BYTES) throw new NativeMessageError(`message of ${length} bytes is too large`);
    }
    if (length !== null && buffered.length >= 4 + length) {
      const body = new TextDecoder().decode(buffered.subarray(4, 4 + length));
      try {
        return JSON.parse(body);
      } catch {
        throw new NativeMessageError("message isn't JSON");
      }
    }
  }
  throw new NativeMessageError("stdin closed before a whole message arrived");
}

export interface NativeHostDeps {
  /** Always the real system hosts file when Chrome runs focus; a temp file in tests. */
  systemHostsFile: string;
  allowlistPath: string;
  feedsPath: string;
  extensionSource: string;
  extensionDir: string;
  statsPath: string;
  now(): number;
  version: string;
  log(text: string): void;
}

export interface StatusReply {
  protocol: number;
  version: string;
  state: "on" | "off" | "none" | "error";
  /** Whether Reddit is limited to `allow`: true once `focus reddit allow` has written the list. */
  reddit: boolean;
  allow: string[];
  /** The sites whose feeds are blocked. */
  feeds: string[];
  /** Reddit is in the hosts section, so DNS blocks it whatever the extension allows. */
  redditBlockedByHosts: boolean;
  /** focus rewrote the extension's folder for this version; the extension should reload. */
  reload: boolean;
  /** While on, every host the hosts file blocks, so the extension can count tries to open them. */
  blockedHosts: string[];
  /** How many of the request's `record` entries were handled; the extension forgets that many. Absent if they couldn't be saved. */
  recorded?: number;
  /** The hosts file couldn't be read; the extension keeps its last rules. */
  error?: string;
  /** The allowlist couldn't be read, so `allow` is empty: nothing is allowed while on, and off still means off. */
  allowlistError?: string;
  /** The feeds file couldn't be read, so every feed is blocked. */
  feedsError?: string;
}

export async function respond(request: unknown, deps: NativeHostDeps): Promise<StatusReply | { error: string }> {
  if (typeof request !== "object" || request === null || (request as { type?: unknown }).type !== "status") {
    return { error: "focus only answers status requests" };
  }
  const reply: StatusReply = {
    protocol: PROTOCOL,
    version: deps.version,
    state: "none",
    reddit: false,
    allow: [],
    feeds: [],
    redditBlockedByHosts: false,
    reload: false,
    blockedHosts: [],
  };

  try {
    const section = readSection((await readHostsFile(deps.systemHostsFile)).content);
    // An empty section is kept for Chrome settings alone, so its state counts too.
    reply.state = section ? section.state : "none";
    reply.redditBlockedByHosts = section !== null && blocksReddit(section);
    if (section?.state === "on") reply.blockedHosts = [...section.presets.flatMap((group) => group.hosts), ...section.sites];
  } catch (error) {
    reply.state = "error";
    reply.error =
      error instanceof HostsFormatError
        ? `the focus section of the hosts file is malformed (${error.message})`
        : messageOf(error);
  }
  // Separate from the state, so a bad allowlist can't stop `focus off` from turning the extension off.
  try {
    const list = await readAllowlist(deps.allowlistPath);
    reply.reddit = list.found && list.enabled;
    reply.allow = list.allow;
  } catch (error) {
    reply.reddit = true;
    reply.allowlistError = messageOf(error);
  }
  try {
    reply.feeds = await readFeeds(deps.feedsPath);
  } catch (error) {
    reply.feeds = FEED_SITES.map((site) => site.id);
    reply.feedsError = messageOf(error);
  }

  const { record } = request as { record?: unknown };
  if (Array.isArray(record)) {
    try {
      await appendEvents(deps.statsPath, blockedEvents(record, deps.now()));
      // Entries that weren't valid count as handled too, so the extension doesn't keep sending them.
      reply.recorded = record.length;
    } catch (error) {
      deps.log(`focus: couldn't save stats: ${messageOf(error)}\n`);
    }
  }

  // Only a folder focus wrote reports a version_name, so a development copy is never rewritten.
  const { extensionVersion } = request as { extensionVersion?: unknown };
  if (typeof extensionVersion === "string" && extensionVersion !== deps.version && (await isDirectory(deps.extensionDir))) {
    try {
      await writeExtension(deps.extensionSource, deps.extensionDir, deps.version);
      reply.reload = true;
    } catch (error) {
      deps.log(`focus: couldn't update the Chrome extension: ${(error as Error).message}\n`);
    }
  }
  return reply;
}

/** At most this many entries per request; the extension sends what it has saved up, and keeps at most 1,000. */
export const MAX_RECORDED = 1000;
const HOST_PATTERN = /^[a-z0-9.-]{1,253}$/;
const SITE_PATTERN = /^[a-z]{1,32}$/;

/** The extension's blocked pages as stats events: valid entries only, timed between a year ago and now. */
export function blockedEvents(record: unknown[], now: number): BlockedEvent[] {
  const events: BlockedEvent[] = [];
  for (const entry of record.slice(0, MAX_RECORDED)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { at, host, site, mode } = entry as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at) || at > now + 60_000 || at < now - 366 * 24 * 60 * 60 * 1000) continue;
    if (typeof host !== "string" || !HOST_PATTERN.test(host)) continue;
    if (mode !== "whole" && mode !== "partial") continue;
    if (site !== undefined && (typeof site !== "string" || !SITE_PATTERN.test(site))) continue;
    events.push({ at: new Date(at).toISOString(), event: "blocked", host, ...(site ? { site } : {}), mode });
  }
  return events;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the hosts section lists Reddit, so DNS blocks every subreddit while focus is on. */
export function blocksReddit(section: FocusSection): boolean {
  const hosts = [...section.presets.flatMap((group) => group.hosts), ...section.sites];
  return hosts.some((host) => host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it");
}
