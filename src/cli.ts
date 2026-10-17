#!/usr/bin/env bun
import { access, constants, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ChromeDeps,
  type LoadedExtension,
  defaultChromePaths,
  findLoadedExtension,
  installedExtensionVersion,
  isDirectory,
  readExtensionId,
  removeChromeFiles,
  writeExtension,
  writeNativeHostManifest,
} from "./chrome.ts";
import { ConfigError, type LoadedConfig, loadConfig, resolveConfigPath } from "./config.ts";
import { unifiedDiff } from "./diff.ts";
import { InvalidHostnameError, normalizeHostname } from "./hostname.ts";
import { type FocusSection, HostsFormatError, isEmpty, readSection, writeSection } from "./hosts.ts";
import {
  ConcurrentModificationError,
  SYSTEM_HOSTS_FILE,
  backupPath,
  readHostsFile,
  writeHostsFile,
} from "./hostsfile.ts";
import {
  SUDOERS_FILE,
  SudoSetupError,
  type SudoersDeps,
  installSudoersRule,
  removeSudoersRule,
  sudoersRule,
} from "./sudo.ts";
import { NativeMessageError, blocksReddit, encodeMessage, readMessage, respond } from "./nativehost.ts";
import {
  PRESETS,
  type Preset,
  findPreset,
  presetBlocking,
  suggestPresets,
  syncSection,
  withPresets,
} from "./presets.ts";
import { type Mode, type SiteRow, type SitesChoice, type SitesOptions, askText, chooseSites } from "./prompt.ts";
import {
  MAX_SUBREDDITS,
  SubredditError,
  defaultAllowlistPath,
  normalizeSubreddit,
  readAllowlist,
  writeAllowlist,
} from "./subreddits.ts";
import { FEED_SITES, type FeedSite, type FeedSiteId, defaultFeedsPath, findFeedSite, readFeeds, writeFeeds } from "./feeds.ts";
import { type BlockingState, type StateEvent, appendEvents, defaultStatsPath, formatSummary, lastState, readEvents, summarize } from "./stats.ts";
import { SPINNER, fileUrl, hyperlink, styles, supportsHyperlinks } from "./terminal.ts";
import { UpgradeError, type UpgradeProgress, type UpgradeResult, upgrade } from "./upgrade.ts";
import { VERSION } from "./version.ts";

const USAGE = `Usage: focus [command] [options]

Block distracting websites by managing a marked section of /etc/hosts.

Commands:
  (none)                  Toggle blocking: on if it's off, off if it's on
  init [preset...]        Set focus up: choose what to block, one row per site. Names set the presets
                          exactly instead. Presets: ${PRESETS.map((p) => p.id).join(", ")}
  config                  Change what's blocked: whole sites, and the Chrome options below
  add <host|preset...>    Block hostnames (and www.<host> unless --exact), or turn presets on
  remove <host|preset...> Unblock hostnames (and www.<host> unless --exact), or turn presets off
  on                      Turn blocking on for everything listed
  off                     Turn blocking off but keep the list
  status                  Show whether blocking is on and what's listed
  stats                   How long focus was on each day, and how often Chrome tried to open a
                          blocked site (--days <n>, default 7)
  sync                    Update presets to this version's hostnames
  feeds add <site...>     In Chrome, block only the feed of these sites, not all of them: ${FEED_SITES.map((site) => site.id).join(", ")}
  feeds remove <site...>  Stop blocking their feeds
  feeds list              Show the sites whose feeds are blocked
  reddit allow <name...>  In Chrome, block Reddit except these subreddits
  reddit disallow <name...>
                          Take subreddits off that list
  reddit list             Show the allowed subreddits
  chrome install          Set up the Chrome extension that does the above (uninstall removes it;
                          update brings its files up to date, which upgrade does for you)
  upgrade                 Install the latest release, then sync (--dry-run only checks)
  setup-sudo              Let focus get root without a password (--remove undoes it)
  version                 Print the version

Options:
  -n, --dry-run          Print a diff of the hosts file instead of writing it
  -y, --yes              init: keep the current presets (or the recommended ones) without prompting
      --preset           add/remove: treat every argument as a preset name
      --[no-]exact       Don't add or remove the www. variant (default: false)
      --hosts-file <path> Hosts file to manage (default: $FOCUS_HOSTS_FILE or /etc/hosts)
      --[no-]flush       Flush the macOS DNS cache after writing (default: true)
      --remove           setup-sudo: remove the rule instead of installing it
      --days <n>         stats: how many days to show (default: 7)
  -h, --help             Show this help
  -v, --version          Print the version

Config:
  Defaults for --exact and --flush can be set in ~/.config/focus/config.json
  (or $XDG_CONFIG_HOME/focus/config.json, or $FOCUS_CONFIG). Under sudo, ~ is
  your home, not root's. Example: { "exact": true, "flushDns": false }

Changing /etc/hosts requires root. focus asks sudo for it when needed; run
\`focus setup-sudo\` once to skip the password prompt.`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  color: boolean;
  /** stdout is a terminal, so it can show links. */
  stdoutIsTerminal: boolean;
  /** stderr is a terminal, so progress can redraw a single line instead of printing one per step. */
  stderrIsTerminal: boolean;
  sleep(ms: number): Promise<void>;
  /**
   * Reads one key without echoing it: Enter, Esc ("skip") or Ctrl-C ("interrupt"). `key` never
   * resolves without a terminal. Call `stop` when done, which gives the terminal back.
   */
  readKey(): { key: Promise<Key>; stop(): void };
  /** Called after /etc/hosts itself (never any other file) has been rewritten. */
  flushDns(): Promise<void>;
  /** The per-site list for `config` and `init`, or null if cancelled. Absent without a terminal. */
  chooseSites?(rows: SiteRow[], initial: Record<string, Mode>, options: SitesOptions): Promise<SitesChoice | null>;
  /** One line of text, or null if cancelled. Absent without a terminal. */
  askText?(message: string, placeholder: string): Promise<string | null>;
  upgrade(dryRun: boolean, progress: (event: UpgradeProgress) => void): Promise<UpgradeResult>;
  /** Runs a binary with the given arguments and this process's stdio; resolves to its exit code. */
  runBinary(path: string, args: string[]): Promise<number>;
  isRoot: boolean;
  /** The real system hosts file. The only file focus touches as root, and the only one it flushes DNS for. */
  systemHostsFile: string;
  /** Re-runs focus as root through sudo with these arguments; resolves to the exit code. */
  elevate(argv: string[]): Promise<number>;
  /** Path of the installed compiled binary, or null when running from source. */
  binaryPath: string | null;
  sudoers: SudoersDeps;
  /** Paths for the subreddit allowlist and the Chrome extension. */
  chrome: ChromeDeps;
  /** The stats file: when focus was on, and the blocked pages the extension reported. Written only as the user. */
  statsPath: string;
  now(): number;
  /** Chrome's pipe when it runs focus as the extension's native-messaging host. */
  nativeMessaging: {
    input(): AsyncIterable<Uint8Array>;
    output(bytes: Uint8Array): Promise<void>;
  };
}

class UsageError extends Error {}

/** Ctrl-C at one of focus's own prompts, where the terminal doesn't turn it into SIGINT. */
class Interrupted extends Error {}

export type Key = "enter" | "skip" | "interrupt";

export async function run(argv: string[], io: Io): Promise<number> {
  // Chrome runs the native-messaging host with the calling extension's origin as its only argument.
  if (argv[0]?.startsWith("chrome-extension://")) return runNativeHost(io);
  // Stats are about the real hosts file, and kept as the user: root never writes them.
  const before = io.isRoot ? null : await blockingState(io);
  if (before) await recordState(before, io, { seen: true });
  try {
    return await runCommand(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`focus: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (error instanceof Interrupted) return 130;
    io.stderr(`focus: ${describeError(error)}\n`);
    return 1;
  } finally {
    // Through sudo, the change is made by a child process; this one sees the result.
    const after = before && (await blockingState(io));
    if (after && after !== before) await recordState(after, io, { seen: false });
  }
}

/** Whether the system hosts file blocks right now, for stats; null if it can't be read or parsed. */
async function blockingState(io: Io): Promise<BlockingState | null> {
  try {
    return readSection((await readHostsFile(io.systemHostsFile)).content)?.state === "on" ? "on" : "off";
  } catch {
    return null;
  }
}

/**
 * Logs a change of state. With `seen`, only if it differs from the last one logged: the
 * change was made elsewhere (as root, or by hand) and focus only noticed it now. Stats
 * never get in the way of a command, so a failure to write them is ignored.
 */
async function recordState(state: BlockingState, io: Io, { seen }: { seen: boolean }): Promise<void> {
  try {
    // Nothing logged yet counts as off, so the first note is only ever that focus is on.
    if (seen && (lastState(await readEvents(io.statsPath)) ?? "off") === state) return;
    const event: StateEvent = { at: new Date(io.now()).toISOString(), event: state, ...(seen ? { seen: true as const } : {}) };
    await appendEvents(io.statsPath, [event]);
  } catch {}
}

async function stats(args: string[], days: number, io: Io): Promise<number> {
  if (args.length > 0) throw new UsageError("stats takes no arguments");
  const summary = summarize(await readEvents(io.statsPath), io.now(), days);
  io.stdout(formatSummary(summary, { inChrome: await isDirectory(io.chrome.extensionDir) }));
  return 0;
}

async function runCommand(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        "dry-run": { type: "boolean", short: "n" },
        exact: { type: "boolean" },
        "hosts-file": { type: "string" },
        // Internal: passed through sudo when the user has Chrome settings, which root can't read.
        "keep-empty": { type: "boolean" },
        // Internal: `config` runs hosts changes with this and prints one summary of its own.
        quiet: { type: "boolean" },
        days: { type: "string" },
        flush: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        preset: { type: "boolean" },
        remove: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;

  if (values.version || command === "version") {
    io.stdout(VERSION + "\n");
    return 0;
  }
  if (values.help || command === "help") {
    io.stdout(USAGE + "\n");
    return 0;
  }
  if (command === "upgrade" || command === "self-update") {
    if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
    if (!values["dry-run"] && !io.isRoot && io.binaryPath && !(await isWritable(dirname(await realpath(io.binaryPath))))) {
      // Only ask for root once there's actually something to install.
      const status = statusLine(io);
      const check = await io.upgrade(true, (event) => status.show(describeProgress(event))).finally(status.clear);
      if (check.status !== "available") {
        io.stdout(formatUpgrade(check));
        return 0;
      }
      const code = await elevate(argv, io);
      // As the user, not root: the extension's folder is theirs.
      if (code === 0) await updateExtensionAfterUpgrade(await realpath(io.binaryPath), io);
      return code;
    }
    const status = statusLine(io);
    const result = await io
      .upgrade(values["dry-run"] ?? false, (event) => status.show(describeProgress(event)))
      .finally(status.clear);
    io.stdout(formatUpgrade(result));
    if (result.status !== "upgraded") return 0;

    // The new binary knows the new preset lists, so it does the sync.
    const syncArgs = [
      "sync",
      ...(values["hosts-file"] ? ["--hosts-file", values["hosts-file"]] : []),
      ...(values.flush === false ? ["--no-flush"] : []),
    ];
    if ((await io.runBinary(result.path, syncArgs)) !== 0) {
      io.stderr("focus: the upgrade succeeded but syncing presets failed; run `focus sync`\n");
      return 1;
    }
    if (!io.isRoot) await updateExtensionAfterUpgrade(result.path, io);
    return 0;
  }

  if (command === "setup-sudo") {
    if (args.length > 0) throw new UsageError("setup-sudo takes no arguments");
    return setupSudo(argv, { remove: values.remove ?? false, dryRun: values["dry-run"] ?? false }, io);
  }
  if (values.remove) throw new UsageError("--remove only works with setup-sudo");
  if (values.days !== undefined && command !== "stats") throw new UsageError("--days only works with stats");
  if (command === "stats") {
    // The stats file is the user's, like the allowlist; under sudo, ~ would be root's.
    if (io.isRoot) throw new UsageError("run `focus stats` as yourself, not with sudo");
    const days = values.days === undefined ? 7 : Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new UsageError("--days takes a number of days from 1 to 366");
    return stats(args, days, io);
  }

  const hostsPath = values["hosts-file"] ?? io.env.FOCUS_HOSTS_FILE ?? io.systemHostsFile;
  const targetsSystemHosts = await isSameFile(hostsPath, io.systemHostsFile);
  // Passwordless sudo must not become a way to write arbitrary root-owned files.
  if (io.isRoot && !targetsSystemHosts) {
    throw new UsageError(`as root, focus only manages ${io.systemHostsFile}; --hosts-file and FOCUS_HOSTS_FILE can't point elsewhere`);
  }
  if (command === "reddit" || command === "feeds" || command === "chrome") {
    // --flush applies to the `focus remove` that feeds and reddit offer to run.
    const options = command === "chrome" ? (["exact", "flush", "preset", "yes"] as const) : (["exact", "preset", "yes"] as const);
    const ignored = options.filter((name) => values[name] !== undefined);
    if (ignored.length > 0) throw new UsageError(`--${ignored[0]} doesn't apply to focus ${command}`);
    // The allowlist, the feeds and Chrome's files are the user's; root never touches them.
    if (io.isRoot) throw new UsageError(`run \`focus ${command}\` as yourself, not with sudo; it never needs root`);
    if (values["dry-run"]) throw new UsageError(`--dry-run doesn't apply to focus ${command}`);
    // Keep the extension's files at this version. install, update and uninstall see to the files themselves.
    if (command !== "chrome" && !["install", "uninstall"].includes(args[0] ?? "")) await updateExtensionFiles(io);
    const hostsArgs = [
      ...(values["hosts-file"] ? ["--hosts-file", values["hosts-file"]] : []),
      ...(values.flush === undefined ? [] : [values.flush ? "--flush" : "--no-flush"]),
    ];
    if (command === "feeds") return feeds(args, hostsPath, hostsArgs, io);
    if (command === "chrome") return chrome(args, hostsPath, null, io);
    return reddit(args, hostsPath, hostsArgs, io);
  }
  // The per-site list runs as you; whatever needs root is re-run through sudo once you've chosen.
  if (command === "config" || (command === "init" && args.length === 0 && !values.yes && io.chooseSites)) {
    if (command === "config" && args.length > 0) throw new UsageError("config takes no arguments");
    const passthrough = [
      ...(values["hosts-file"] ? ["--hosts-file", values["hosts-file"]] : []),
      ...(values.flush === undefined ? [] : [values.flush ? "--flush" : "--no-flush"]),
      ...(values["dry-run"] ? ["--dry-run"] : []),
    ];
    return configure(command, hostsPath, passthrough, values["dry-run"] ?? false, io);
  }
  // With Chrome settings, the section stays even with no hosts in it: it holds the on/off
  // state the extension follows. Root can't read those settings, so it's told by flag.
  const keepEmpty = values["keep-empty"] ?? (io.isRoot ? false : await usesChrome(io));
  // A bare `focus` with nothing to toggle shows help instead of asking sudo for nothing.
  if (command === undefined && !keepEmpty && !readSection((await readHostsFile(hostsPath)).content)) {
    io.stdout(USAGE + "\n");
    return 0;
  }
  if (!io.isRoot && targetsSystemHosts && (command === undefined || MUTATING_COMMANDS.has(command)) && !values["dry-run"]) {
    return elevate(keepEmpty && values["keep-empty"] === undefined ? [...argv, "--keep-empty"] : argv, io);
  }

  const sudoUid = io.isRoot && io.env.SUDO_UID ? Number(io.env.SUDO_UID) : undefined;
  const loaded = await loadConfig(await resolveConfigPath(io.env), sudoUid);
  const exact = values.exact ?? loaded.config.exact;
  const flush = values.flush ?? loaded.config.flushDns;

  const snapshot = await readHostsFile(hostsPath);
  const parsedSection = readSection(snapshot.content);
  // Every command works from the synced section, so any write also brings presets up to date.
  const current = parsedSection && syncSection(parsedSection);

  if (command === "status") {
    if (args.length > 0) throw new UsageError("status takes no arguments");
    io.stdout(formatStatus(snapshot.path, current));
    if (current && writeSection(snapshot.content, current) !== snapshot.content) {
      io.stdout("Sync:       needed, the presets changed in this version; run `focus sync`\n");
    }
    // Root never reads the allowlist; it's the user's file and only the extension uses it.
    if (!io.isRoot) {
      io.stdout(
        (await formatSubreddits(io.chrome.allowlistPath, current)) +
          (await formatFeeds(io.chrome.feedsPath, current)) +
          (await formatExtension(io)),
      );
    }
    io.stdout(formatConfig(loaded));
    return 0;
  }

  let next: FocusSection | null;
  if (command === "init") {
    next = withPresets(current, choosePresets(args, values.yes ?? false, current));
  } else {
    next = planChange(command, args, current, { exact, preset: values.preset ?? false, keepEmpty }, io);
  }
  if (!values.quiet && current?.state === "off" && next && [...allHosts(next)].some((host) => !allHosts(current).has(host))) {
    io.stderr("focus: blocking is off; run `focus on` to block these sites\n");
  }

  const updated = writeSection(snapshot.content, next, keepEmpty);
  if (updated === snapshot.content) {
    if (!values.quiet) io.stdout(`No changes to ${snapshot.path}.\n`);
    return 0;
  }

  if (values["dry-run"]) {
    const diff = unifiedDiff(snapshot.content, updated, snapshot.path, `${snapshot.path} (after focus${command ? ` ${command}` : ""})`);
    io.stdout(io.color ? colorizeDiff(diff) : diff);
    io.stdout(`\nDry run: ${snapshot.path} was not modified.\n`);
    return 0;
  }

  try {
    await writeHostsFile(snapshot, updated);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`permission denied writing ${snapshot.path}. Re-run with sudo.`);
    }
    throw error;
  }
  if (!values.quiet) {
    io.stdout(formatStatus(snapshot.path, next));
    io.stdout(`Previous version saved to ${backupPath(snapshot)}.\n`);
  }

  if (flush && targetsSystemHosts) {
    try {
      await io.flushDns();
    } catch (error) {
      io.stderr(`focus: warning: couldn't flush the DNS cache (${describeError(error)}). Changes may take a minute to apply.\n`);
    }
  }
  return 0;
}

const MUTATING_COMMANDS = new Set(["init", "add", "remove", "rm", "on", "off", "sync"]);

async function elevate(argv: string[], io: Io): Promise<number> {
  if (!(await Bun.file(io.sudoers.path).exists())) {
    io.stderr("focus: this needs root, so asking sudo. Run `focus setup-sudo` once to skip the password.\n");
  }
  return io.elevate(argv);
}

async function setupSudo(argv: string[], options: { remove: boolean; dryRun: boolean }, io: Io): Promise<number> {
  if (!io.binaryPath) {
    throw new SudoSetupError("setup-sudo only works with the installed focus binary, not when running from source");
  }
  const binary = await realpath(io.binaryPath);
  if (options.dryRun) {
    const user = io.env.SUDO_USER ?? io.env.USER ?? "";
    io.stdout(
      options.remove
        ? `Would remove ${io.sudoers.path}.\n`
        : `Would install ${io.sudoers.path}:\n\n${sudoersRule(user, binary)}`,
    );
    return 0;
  }
  if (!io.isRoot) return io.elevate(argv);

  if (options.remove) {
    const removed = await removeSudoersRule(io.sudoers);
    io.stdout(removed ? `Removed ${io.sudoers.path}; focus will ask for your password again.\n` : "No sudoers rule was installed.\n");
    return 0;
  }
  const user = io.env.SUDO_USER;
  if (!user || user === "root") {
    throw new SudoSetupError("run `focus setup-sudo` as your own user, not as root; it asks sudo for root itself");
  }
  await installSudoersRule(user, binary, io.sudoers);
  io.stdout(`Installed ${io.sudoers.path}. ${user} can now run focus without sudo or a password.\n`);
  return 0;
}

async function reddit(args: string[], hostsPath: string, hostsArgs: string[], io: Io): Promise<number> {
  const [subcommand, ...names] = args;
  const path = io.chrome.allowlistPath;

  switch (subcommand) {
    case "allow": {
      const requested = parseSubreddits(names, "reddit allow");
      const { allow } = await readAllowlist(path);
      for (const name of requested) if (allow.includes(name)) io.stderr(`focus: r/${name} is already allowed\n`);
      const added = requested.filter((name) => !allow.includes(name));
      if (allow.length + added.length > MAX_SUBREDDITS) {
        throw new UsageError(`focus allows at most ${MAX_SUBREDDITS} subreddits`);
      }
      if (added.length > 0) {
        await writeAllowlist(path, [...allow, ...added]);
        io.stdout(`Allowed in Chrome: ${added.map((name) => `r/${name}`).join(", ")}\n`);
      }
      return afterChromeChange(["reddit"], hostsPath, hostsArgs, io);
    }
    case "disallow": {
      const requested = parseSubreddits(names, "reddit disallow");
      const { allow } = await readAllowlist(path);
      for (const name of requested) if (!allow.includes(name)) io.stderr(`focus: r/${name} isn't allowed\n`);
      const removed = requested.filter((name) => allow.includes(name));
      if (removed.length > 0) {
        await writeAllowlist(path, allow.filter((name) => !removed.includes(name)));
        io.stdout(`No longer allowed: ${removed.map((name) => `r/${name}`).join(", ")}\n`);
      }
      return 0;
    }
    case "list": {
      if (names.length > 0) throw new UsageError("reddit list takes no arguments");
      const { allow } = await readAllowlist(path);
      io.stdout(
        allow.length > 0
          ? allow.map((name) => `r/${name}\n`).join("")
          : "No subreddits are allowed. Add one with `focus reddit allow <name>`.\n",
      );
      return 0;
    }
    case "install":
    case "uninstall":
      // From before `focus chrome`, when the extension only did Reddit.
      return chrome(args, hostsPath, "reddit", io);
    default:
      throw new UsageError(
        subcommand
          ? `unknown reddit command '${subcommand}'`
          : "focus reddit needs a command: allow, disallow, list, install or uninstall",
      );
  }
}

async function feeds(args: string[], hostsPath: string, hostsArgs: string[], io: Io): Promise<number> {
  const [subcommand, ...names] = args;
  const path = io.chrome.feedsPath;
  switch (subcommand) {
    case "add": {
      const requested = parseFeedSites(names, "feeds add");
      const current = await readFeeds(path);
      for (const site of requested) if (current.includes(site.id)) io.stderr(`focus: ${site.name}'s feed is already blocked\n`);
      const added = requested.filter((site) => !current.includes(site.id));
      if (added.length > 0) {
        await writeFeeds(path, [...current, ...added.map((site) => site.id)]);
        const s = styles(io.color);
        for (const site of added) io.stdout(`${s.green("✓")} ${site.name}: ${site.mode}, in Chrome ${s.dim(`(${site.keeps})`)}\n`);
      }
      return afterChromeChange(requested.map((site) => site.preset), hostsPath, hostsArgs, io);
    }
    case "remove": {
      const requested = parseFeedSites(names, "feeds remove");
      const current = await readFeeds(path);
      for (const site of requested) if (!current.includes(site.id)) io.stderr(`focus: ${site.name}'s feed isn't blocked\n`);
      const removed = requested.filter((site) => current.includes(site.id));
      if (removed.length > 0) {
        await writeFeeds(path, current.filter((id) => !removed.some((site) => site.id === id)));
        io.stdout(`No longer blocking the feed of ${removed.map((site) => site.name).join(", ")}\n`);
        io.stdout(`To block all of ${removed.length === 1 ? "it" : "them"} again: focus add ${removed.map((site) => site.preset).join(" ")}\n`);
      }
      return 0;
    }
    case "list": {
      if (names.length > 0) throw new UsageError("feeds list takes no arguments");
      const current = await readFeeds(path);
      io.stdout(
        current.length > 0
          ? current.map((id) => `${id}: ${findFeedSite(id)!.what}\n`).join("")
          : `No feeds are blocked. Add one with \`focus feeds add ${FEED_SITES.map((site) => site.id).join(" ")}\`.\n`,
      );
      return 0;
    }
    default:
      throw new UsageError(
        subcommand ? `unknown feeds command '${subcommand}'` : "focus feeds needs a command: add, remove or list",
      );
  }
}

function parseFeedSites(args: string[], command: string): FeedSite[] {
  if (args.length === 0) throw new UsageError(`${command} needs at least one site: ${FEED_SITES.map((site) => site.id).join(", ")}`);
  const errors: string[] = [];
  const sites: FeedSite[] = [];
  for (const arg of args) {
    const site = findFeedSite(arg);
    if (site) {
      if (!sites.includes(site)) sites.push(site);
      continue;
    }
    const suggestion = suggestPresets(arg).find((preset) => findFeedSite(preset.id));
    errors.push(
      suggestion
        ? `'${arg}' isn't a site whose feed focus can block; did you mean '${suggestion.id}'?`
        : `'${arg}' isn't a site whose feed focus can block; it can for ${FEED_SITES.map((s) => s.id).join(", ")}`,
    );
  }
  if (errors.length > 0) throw new UsageError(errors.join("\n"));
  return sites;
}

/**
 * `focus chrome install|uninstall`. `purpose` is "reddit" when run as `focus reddit install`,
 * which only changes what install suggests next.
 */
async function chrome(args: string[], hostsPath: string, purpose: "reddit" | null, io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  const command = `${purpose ?? "chrome"} ${subcommand}`;
  switch (subcommand) {
    case "install": {
      if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
      if (!io.binaryPath) {
        throw new Error(`${command} only works with the installed focus binary, not when running from source`);
      }
      const binary = await realpath(io.binaryPath);
      const { extensionDir, extensionSource, nativeHostsDir } = io.chrome;
      const id = await readExtensionId(extensionSource);
      await writeExtension(extensionSource, extensionDir, VERSION);
      await writeNativeHostManifest(nativeHostsDir, binary, id);
      await finishChromeSetup(id, hostsPath, purpose, io);
      return 0;
    }
    case "update": {
      if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
      if (!(await isDirectory(io.chrome.extensionDir))) {
        io.stderr("focus: the Chrome extension isn't set up; run `focus chrome install`\n");
        return 1;
      }
      if (!(await updateExtensionFiles(io))) io.stdout(`The Chrome extension's files are up to date (${VERSION}).\n`);
      return 0;
    }
    case "uninstall": {
      if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
      // Read before removing the folder: its manifest has the id.
      const loaded = await chromeProfiles(io);
      const id = await readExtensionId(io.chrome.extensionDir).catch(() => null);
      const removed = await removeChromeFiles(io.chrome);
      const home = io.env.HOME;
      io.stdout(
        (removed.length > 0 ? removed.map((file) => `Removed ${tildify(file, home)}\n`).join("") : "Nothing to remove.\n") +
          `Your settings stay in ${tildify(io.chrome.allowlistPath, home)} and ${tildify(io.chrome.feedsPath, home)}.\n` +
          "To block whole sites again: focus add reddit youtube x\n",
      );
      if (loaded?.length !== 0 && id !== null) {
        const where = loaded ? `Chrome still lists the focus extension (${profileNames(loaded)})` : "If Chrome still lists the focus extension";
        io.stdout(`\n${where}; click Remove on its details page, chrome://extensions/?id=${id}.\n`);
        if (io.stdoutIsTerminal && io.stderrIsTerminal && (await confirm("Press Enter to open it", io))) {
          await io.chrome.openInChrome(`chrome://extensions/?id=${id}`).catch(() => false);
        }
      }
      return 0;
    }
    default:
      throw new UsageError(
        subcommand ? `unknown chrome command '${subcommand}'` : "focus chrome needs a command: install, update or uninstall",
      );
  }
}

/**
 * Brings the extension's folder up to this version if it's from another one, and says so.
 * Chrome keeps running the copy it loaded until it restarts (the extension can also reload
 * itself when it next checks in with focus, but that isn't dependable), so say to restart it.
 * One Chrome hasn't loaded yet gets the current files when it is. Only the installed binary does this,
 * so running from source never rewrites the real folder. Resolves whether it wrote anything.
 */
async function updateExtensionFiles(io: Io): Promise<boolean> {
  if (!io.binaryPath || !(await isDirectory(io.chrome.extensionDir))) return false;
  const installed = await installedExtensionVersion(io.chrome.extensionDir);
  if (installed === VERSION) return false;
  await writeExtension(io.chrome.extensionSource, io.chrome.extensionDir, VERSION);
  const loaded = await chromeProfiles(io);
  io.stdout(
    `Updated the Chrome extension's files${installed ? ` from ${installed}` : ""} to ${VERSION}. ` +
      (loaded?.length === 0
        ? "Chrome hasn't loaded it yet; run `focus chrome install`.\n"
        : "Restart Chrome to use the new version (or click ↻ on focus at chrome://extensions).\n"),
  );
  return true;
}

/**
 * After changing what Chrome restricts: points out what stops it from working, and offers
 * to turn off presets that block these sites whole (the hosts file stops them before
 * Chrome sees them, so the finer setting would do nothing).
 */
async function afterChromeChange(presetIds: string[], hostsPath: string, hostsArgs: string[], io: Io): Promise<number> {
  const section = readSection((await readHostsFile(hostsPath)).content);
  if (!section) io.stderr("focus: focus isn't on yet; run `focus on` to start\n");
  if (!(await isDirectory(io.chrome.extensionDir))) {
    io.stderr("focus: the Chrome extension isn't set up yet; run `focus chrome install`\n");
  } else if ((await chromeProfiles(io))?.length === 0) {
    io.stderr("focus: Chrome hasn't loaded the extension yet; run `focus chrome install` to finish setting it up\n");
  }
  const blocking = (section?.presets ?? []).map((group) => group.id).filter((id) => presetIds.includes(id));
  if (blocking.length === 0) return 0;
  const names = blocking.map((id) => findPreset(id)?.name ?? id).join(" and ");
  const remove = ["remove", ...blocking];
  io.stdout(`\nThe hosts file still blocks all of ${names} while focus is on, so this has no effect yet.\n`);
  if (io.stdoutIsTerminal && io.stderrIsTerminal) {
    if (await confirm(`Press Enter to stop that (runs \`focus ${remove.join(" ")}\`)`, io)) {
      return runCommand([...remove, ...hostsArgs], io);
    }
    return 0;
  }
  io.stdout(`To stop that: focus ${remove.join(" ")}\n`);
  return 0;
}

function parseSubreddits(args: string[], command: string): string[] {
  if (args.length === 0) throw new UsageError(`${command} needs at least one subreddit`);
  const errors: string[] = [];
  const names: string[] = [];
  for (const arg of args) {
    try {
      const name = normalizeSubreddit(arg);
      if (!names.includes(name)) names.push(name);
    } catch (error) {
      if (!(error instanceof SubredditError)) throw error;
      errors.push(error.message);
    }
  }
  if (errors.length > 0) throw new UsageError(errors.join("\n"));
  return names;
}

/** Points out the two setups in which the allowlist does nothing. */
const ADD_ROW = "\0add";

/**
 * `focus config`, and `focus init` as its first-run version: one row per site, each set to
 * off, the whole site (hosts file) or, for some, part of it in Chrome. Nothing is written
 * until everything has been asked; then the hosts file changes first (through sudo, as
 * usual), and the Chrome settings only once that has worked, so a cancelled password prompt
 * leaves everything as it was. Root gets only off and whole: the Chrome settings are yours.
 */
async function configure(kind: "config" | "init", hostsPath: string, passthrough: string[], dryRun: boolean, io: Io): Promise<number> {
  if (!io.chooseSites) {
    throw new UsageError("config needs an interactive terminal; use add, remove, feeds and reddit instead");
  }
  const s = styles(io.color);
  const section = readSection((await readHostsFile(hostsPath)).content);
  const synced = section ? syncSection(section) : null;
  const currentPresets = synced?.presets.map((group) => group.id) ?? [];
  const chromeSettings = !io.isRoot;
  const feedIds = chromeSettings ? await readFeeds(io.chrome.feedsPath) : [];
  const list = chromeSettings ? await readAllowlist(io.chrome.allowlistPath) : null;
  const redditOn = list !== null && list.found && list.enabled;
  const partialOn = (presetId: string) =>
    presetId === "reddit" ? redditOn : feedIds.some((id) => findFeedSite(id)!.preset === presetId);

  // What's on disk now, row by row: the baseline for what changes.
  const rows: SiteRow[] = PRESETS.map((preset) => presetRow(preset, chromeSettings, list?.allow ?? [], currentPresets.includes(preset.id) && partialOn(preset.id)));
  const onDisk: Record<string, Mode> = {};
  for (const preset of PRESETS) {
    onDisk[preset.id] = currentPresets.includes(preset.id) ? "whole" : chromeSettings && partialOn(preset.id) ? "partial" : "off";
  }
  const customHosts = new Map<string, string[]>();
  for (const host of synced?.sites ?? []) {
    const base = host.replace(/^www\./, "");
    customHosts.set(base, [...(customHosts.get(base) ?? []), host]);
  }
  for (const [base, hosts] of customHosts) {
    rows.push(siteRow(base, hosts));
    onDisk[`site:${base}`] = "whole";
  }

  const firstRun = kind === "init" && !synced && feedIds.length === 0 && !list?.found;
  let values: Record<string, Mode> = firstRun
    ? Object.fromEntries(PRESETS.map((preset) => [preset.id, preset.recommended ? "whole" : "off"]))
    : { ...onDisk };
  if (kind === "init") {
    io.stdout(
      `${s.bold("focus")} blocks distracting sites while it's on. Choose what to block; change it any time with \`focus config\`.\n` +
        (chromeSettings ? "" : "Running as root, so only whole sites are offered; run it without sudo for the Chrome options.\n") +
        "\n",
    );
  }
  const header = synced ? `focus is ${synced.state}` : kind === "config" ? "focus isn't set up yet" : undefined;

  // The list, coming back to it after each site added.
  const added: string[] = [];
  let focus: string | undefined;
  for (;;) {
    const choice = await io.chooseSites(rows, values, { message: "What should focus block?", header, focus });
    if (choice === null) {
      io.stdout("Cancelled; nothing was changed.\n");
      return 0;
    }
    values = choice.values;
    if (!choice.add) break;
    focus = ADD_ROW;
    const answer = io.askText ? await io.askText("Which site? A hostname, like example.com.", "example.com") : null;
    if (answer === null || answer.trim() === "") continue;
    let host: string;
    try {
      host = normalizeHostname(answer);
    } catch (error) {
      io.stdout(`${(error as Error).message}\n`);
      continue;
    }
    const base = host.replace(/^www\./, "");
    const owner = PRESETS.find((preset) => preset.hosts.includes(host));
    if (owner) {
      io.stdout(`${host} is part of ${owner.name}; set it on that row.\n`);
      focus = owner.id;
      continue;
    }
    focus = `site:${base}`;
    if (!rows.some((row) => row.id === focus)) {
      rows.push(siteRow(base, [host]));
      added.push(host);
    }
    values = { ...values, [focus]: "whole" };
  }

  // What to change, row by row; a row left as it was keeps everything on disk as it is.
  const changed = rows.filter((row) => values[row.id] !== (onDisk[row.id] ?? "off"));
  if (changed.length === 0) {
    io.stdout("No changes.\n");
    return 0;
  }
  const changedIds = new Set(changed.map((row) => row.id));
  const nextPresets = PRESETS.map((preset) => preset.id).filter((id) => (changedIds.has(id) ? values[id] === "whole" : currentPresets.includes(id)));
  const nextFeeds = FEED_SITES.filter((site) =>
    changedIds.has(site.preset) ? values[site.preset] === "partial" : feedIds.includes(site.id),
  ).map((site) => site.id);
  const nextReddit = changedIds.has("reddit") ? values.reddit === "partial" : redditOn;
  const removedHosts = [...customHosts].filter(([base]) => values[`site:${base}`] === "off").flatMap(([, hosts]) => hosts);
  const addedHosts = added.filter((host) => values[`site:${host.replace(/^www\./, "")}`] === "whole");

  // Ask what's still needed before writing anything.
  let allow = list?.allow ?? [];
  if (nextReddit && !redditOn && allow.length === 0) {
    const answer = io.askText ? await io.askText("Which subreddits should load? Separate them with spaces.", "rust AskHistorians") : null;
    if (answer === null) {
      io.stdout("Cancelled; nothing was changed.\n");
      return 0;
    }
    allow = answer.trim() === "" ? [] : parseSubreddits(answer.trim().split(/[\s,]+/), "config");
  }

  // The hosts file first. Its section also holds the on/off state for Chrome settings alone.
  const usesChromeAfter = chromeSettings && (nextFeeds.length > 0 || nextReddit);
  const steps: string[][] = [];
  if (nextPresets.join() !== currentPresets.join()) {
    steps.push(nextPresets.length > 0 ? ["init", ...nextPresets] : ["remove", "--preset", ...currentPresets]);
  }
  if (removedHosts.length > 0) steps.push(["remove", "--exact", ...removedHosts]);
  if (addedHosts.length > 0) steps.push(["add", ...addedHosts]);
  if (steps.length === 0 && usesChromeAfter && !synced) steps.push(["on"]);
  if (steps.length === 0 && !usesChromeAfter && synced && isEmpty(synced)) steps.push(["sync"]);
  const keep = chromeSettings ? [usesChromeAfter ? "--keep-empty" : "--no-keep-empty"] : [];
  for (const [index, step] of steps.entries()) {
    let code: number;
    try {
      code = await runCommand([...step, ...keep, "--quiet", ...passthrough], io);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      io.stderr(`focus: ${describeError(error)}\n`);
      code = 1;
    }
    if (code !== 0) {
      io.stderr(
        index === 0
          ? "focus: the hosts file wasn't changed, so nothing else was either\n"
          : "focus: only part of the change reached the hosts file, and the Chrome settings weren't changed; run `focus config` again\n",
      );
      return code;
    }
  }

  // Then the Chrome settings.
  if (chromeSettings && list && !dryRun) {
    if (nextFeeds.join() !== feedIds.join()) await writeFeeds(io.chrome.feedsPath, nextFeeds);
    if (nextReddit !== redditOn || allow !== list.allow) {
      if (nextReddit || list.found) await writeAllowlist(io.chrome.allowlistPath, allow, nextReddit);
    }
  }

  for (const row of changed) {
    const option = row.modes.find((candidate) => candidate.mode === values[row.id]);
    const where = values[row.id] === "partial" ? s.dim(" (in Chrome)") : "";
    const what = row.id.startsWith("site:") && values[row.id] === "off" ? "removed" : option?.label ?? values[row.id];
    io.stdout(`${s.green("✓")} ${row.name}: ${what}${where}${dryRun ? s.dim(" (dry run: not saved)") : ""}\n`);
  }
  if (synced?.state === "off") io.stdout(s.dim("focus is off; these apply when you turn it on with `focus`.\n"));

  // The Chrome options need the extension.
  let code = 0;
  if (usesChromeAfter && !dryRun) {
    const installed = await isDirectory(io.chrome.extensionDir);
    const loaded = installed ? await chromeProfiles(io) : [];
    if (!installed || loaded?.length === 0) {
      io.stdout(`\nThe Chrome options need the focus extension, which Chrome hasn't loaded yet.\n`);
      if (io.binaryPath && io.stdoutIsTerminal && io.stderrIsTerminal && (await confirm("Press Enter to set it up now", io))) {
        io.stdout("\n");
        code = await chrome(["install"], hostsPath, null, io);
      } else {
        io.stdout("Set it up with: focus chrome install\n");
      }
    }
  }

  if (kind === "init" && code === 0 && !dryRun) {
    io.stdout(
      `\n${s.bold("Next")}\n` +
        `  focus             ${s.dim("turn blocking off for a break, and on again")}\n` +
        `  focus config      ${s.dim("change what's blocked")}\n` +
        `  focus setup-sudo  ${s.dim("stop asking for your password")}\n`,
    );
  }
  return code;
}

function presetRow(preset: Preset, chromeSettings: boolean, subreddits: string[], both: boolean): SiteRow {
  const site = findFeedSite(preset.id);
  const partial =
    !chromeSettings
      ? null
      : site
        ? { mode: "partial" as const, label: site.mode, detail: site.detail }
        : preset.id === "reddit"
          ? {
              mode: "partial" as const,
              label: "chosen subreddits",
              detail:
                subreddits.length > 0
                  ? `Only ${subreddits.map((name) => `r/${name}`).join(", ")} load, in Chrome.`
                  : "In Chrome, every subreddit but the ones you choose is blocked.",
            }
          : null;
  const shown = preset.hosts.filter((host) => !host.startsWith("www."));
  return {
    id: preset.id,
    name: preset.name,
    modes: [
      { mode: "off", label: "off", detail: "Not blocked." },
      { mode: "whole", label: "whole site", detail: `Blocked everywhere, through /etc/hosts.${preset.note ? ` (${preset.note})` : ""}` },
      ...(partial ? [partial] : []),
    ],
    hosts: shown.slice(0, 4).join(" · ") + (shown.length > 4 ? " …" : ""),
    note: both ? "Its Chrome option is set too; the whole site wins." : undefined,
  };
}

function siteRow(base: string, hosts: string[]): SiteRow {
  return {
    id: `site:${base}`,
    name: base,
    modes: [
      { mode: "off", label: "off", detail: "Not blocked; leaving it off removes it from the list." },
      { mode: "whole", label: "blocked", detail: "Blocked everywhere, through /etc/hosts." },
    ],
    hosts: hosts.join(" · "),
  };
}

const GUIDE_URL = "https://github.com/brentvatne/focus/blob/main/docs/guide.md#finer-blocking-in-chrome";
/** How long `chrome install` waits for each step in Chrome before giving up. */
const CHROME_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 250;

/**
 * Walks through the steps only Chrome can do: it opens the pages and the folder, then (in a
 * terminal) waits for Chrome to record each step, so you see it worked without leaving.
 */
async function finishChromeSetup(id: string, hostsPath: string, purpose: "reddit" | null, io: Io): Promise<void> {
  const { extensionDir, profilesDir } = io.chrome;
  const s = styles(io.color);
  const links = supportsHyperlinks(io.env, io.stdoutIsTerminal);
  const interactive = io.stdoutIsTerminal && io.stderrIsTerminal;
  const done = (text: string) => io.stdout(`${s.green("✓")} ${text}\n`);
  const shortPath = tildify(extensionDir, io.env.HOME);
  const find = () => findLoadedExtension(profilesDir, id, extensionDir);

  done(`Wrote the extension to ${hyperlink(shortPath, fileUrl(extensionDir), links)}`);
  done("Registered focus with Chrome");

  // Null when Chrome's profiles can't be read: the steps still print, but nothing can wait for them.
  const initial = await find();
  let loaded = initial ?? [];
  if (loaded.length > 0) {
    done(`Chrome already has it loaded (${profileNames(loaded)})`);
  } else {
    io.stdout(
      `\n${s.bold("Load it in Chrome")}\n` +
        `  1. Open chrome://extensions and turn on ${s.bold("Developer mode")}, top right.\n` +
        `  2. Drag the ${s.bold("chrome-extension")} folder from Finder onto the page.\n` +
        `     Or click ${s.bold("Load unpacked")}, press ⌘⇧G, paste this path and press Return:\n` +
        `     ${shortPath}\n`,
    );
    if (interactive && (await confirm("Press Enter to open chrome://extensions, show the folder in Finder and copy its path", io))) {
      const opened = await io.chrome.openInChrome("chrome://extensions/").catch(() => false);
      await io.chrome.reveal(extensionDir).catch(() => {});
      const copied = await io.chrome.copyToClipboard(extensionDir).catch(() => false);
      if (!opened) io.stdout(`  Chrome didn't open; open chrome://extensions in Google Chrome yourself.\n`);
      if (!copied) io.stdout(`  Couldn't copy the path; it's ${shortPath}\n`);
      if (initial === null) {
        io.stdout(`  focus ${CANT_SEE_CHROME}, so it can't wait for you; run \`focus status\` afterwards.\n`);
      } else {
        loaded =
          (await waitForChrome("Waiting for Chrome to load it", io, async () => {
            const found = await find();
            return found && found.length > 0 ? found : null;
          })) ?? [];
        if (loaded.length > 0) done(`Chrome loaded it (${profileNames(loaded)})`);
      }
    }
  }

  if (loaded.length > 0 && !loaded.some((profile) => profile.incognito)) {
    io.stdout(
      `\n${s.bold("Allow it in Incognito")} ${s.dim("(skip this if you don't use Incognito)")}\n` +
        `  Turn on ${s.bold("Allow in Incognito")} on the extension's details page${interactive ? "" : `, chrome://extensions/?id=${id}`}.\n`,
    );
    if (interactive && (await confirm("Press Enter to open its details page", io))) {
      if (!(await io.chrome.openInChrome(`chrome://extensions/?id=${id}`).catch(() => false))) {
        io.stdout(`  Chrome didn't open; go to chrome://extensions/?id=${id} yourself.\n`);
      }
      const allowed = await waitForChrome("Waiting for Incognito access", io, async () =>
        (await find())?.some((profile) => profile.incognito) ? true : null,
      );
      if (allowed) done("Allowed in Incognito");
    }
  }

  const steps: [string, string][] = [];
  const list = await readAllowlist(io.chrome.allowlistPath);
  const feedIds = await readFeeds(io.chrome.feedsPath);
  if (purpose === "reddit" ? list.allow.length === 0 : !list.found && feedIds.length === 0) {
    if (purpose !== "reddit") steps.push([`focus feeds add ${FEED_SITES.map((site) => site.id).join(" ")}`, "block just their feeds"]);
    steps.push(["focus reddit allow <name...>", purpose === "reddit" ? "choose the subreddits to keep" : "limit Reddit to chosen subreddits"]);
  }
  // Presets that block a site whole, while Chrome is set to restrict only part of it.
  const restricted = [...(purpose === "reddit" || (list.found && list.enabled) ? ["reddit"] : []), ...feedIds];
  const section = readSection((await readHostsFile(hostsPath)).content);
  const blocking = (section?.presets ?? []).map((group) => group.id).filter((preset) => restricted.includes(preset));
  if (blocking.length > 0) {
    const names = blocking.map((preset) => findPreset(preset)?.name ?? preset).join(", ");
    steps.push([`focus remove ${blocking.join(" ")}`, `stop the hosts file from blocking all of ${names}`]);
  }
  if (loaded.length === 0) steps.push(["focus status", "check that Chrome has loaded it"]);
  if (steps.length > 0) {
    const width = Math.max(...steps.map(([command]) => command.length));
    io.stdout(`\n${s.bold("Then")}\n${steps.map(([command, why]) => `  ${command.padEnd(width)}  ${s.dim(why)}\n`).join("")}`);
  }
  io.stdout(`\n${s.dim("More, including how to undo it:")} ${hyperlink(links ? "the guide" : GUIDE_URL, GUIDE_URL, links)}\n`);
}

/** Asks before doing something outside the terminal. True for Enter, false for Esc. */
async function confirm(prompt: string, io: Io): Promise<boolean> {
  const s = styles(io.color);
  io.stdout(`\n${prompt} ${s.dim("(Esc skips)")} `);
  const reader = io.readKey();
  try {
    const key = await reader.key;
    io.stdout(key === "skip" ? `${s.dim("skipped")}\n` : "\n");
    if (key === "interrupt") throw new Interrupted();
    return key === "enter";
  } finally {
    reader.stop();
  }
}

/**
 * Polls `check` until it returns something other than null, with a spinner on stderr.
 * Enter, Esc or the time limit stops it early; resolves null then.
 */
async function waitForChrome<T>(label: string, io: Io, check: () => Promise<T | null>): Promise<T | null> {
  const status = statusLine(io);
  const reader = io.readKey();
  let stopped: Key | null = null;
  void reader.key.then((key) => (stopped = key));
  try {
    for (let elapsed = 0, frame = 0; elapsed < CHROME_WAIT_MS; elapsed += POLL_MS, frame++) {
      if (stopped === "interrupt") throw new Interrupted();
      if (stopped) return null;
      const result = await check();
      if (result !== null) return result;
      const hint = elapsed >= 3000 ? " (Chrome saves this within about 10 seconds; Enter stops waiting)" : "";
      status.show({ step: "waiting", text: `${SPINNER[frame % SPINNER.length]} ${label}…${hint}` });
      await io.sleep(POLL_MS);
    }
    return null;
  } finally {
    reader.stop();
    status.clear();
  }
}

function profileNames(loaded: LoadedExtension[]): string {
  return `${loaded.length === 1 ? "profile" : "profiles"} ${loaded.map((profile) => profile.profile).join(", ")}`;
}

function tildify(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Whether any Chrome setting is on: then focus keeps its section in the hosts file even with
 * no hosts in it, for the on/off state. Unreadable settings count as on, so state isn't lost.
 */
async function usesChrome(io: Io): Promise<boolean> {
  try {
    const list = await readAllowlist(io.chrome.allowlistPath);
    return (list.found && list.enabled) || (await readFeeds(io.chrome.feedsPath)).length > 0;
  } catch {
    return true;
  }
}

/** Where Chrome has the installed extension loaded; null if Chrome's profiles can't be read. */
async function chromeProfiles(io: Io): Promise<LoadedExtension[] | null> {
  const id = await readExtensionId(io.chrome.extensionDir).catch(() => null);
  return id ? findLoadedExtension(io.chrome.profilesDir, id, io.chrome.extensionDir) : [];
}

const CANT_SEE_CHROME = "couldn't check whether Chrome has it loaded (no access to Chrome's profile files)";

/** The status line for the extension, once it's been installed. */
async function formatExtension(io: Io): Promise<string> {
  if (!(await isDirectory(io.chrome.extensionDir))) return "";
  const loaded = await chromeProfiles(io);
  if (loaded === null) return `Extension:  set up; ${CANT_SEE_CHROME}\n`;
  if (loaded.length === 0) return "Extension:  not loaded in Chrome; run `focus chrome install` to finish\n";
  const incognito = loaded.some((profile) => profile.incognito) ? "allowed in Incognito" : "not allowed in Incognito";
  return `Extension:  loaded in Chrome (${profileNames(loaded)}), ${incognito}\n`;
}

async function formatFeeds(path: string, section: FocusSection | null): Promise<string> {
  let ids: FeedSiteId[];
  try {
    ids = await readFeeds(path);
  } catch (error) {
    return `In Chrome:  ${describeError(error)}\n`;
  }
  if (ids.length === 0) return "";
  const enabled = section?.presets.map((group) => group.id) ?? [];
  const shadowed = ids.filter((id) => enabled.includes(findFeedSite(id)!.preset)).map((id) => findFeedSite(id)!.name);
  const note = shadowed.length > 0 ? `\n            (no effect for ${shadowed.join(", ")}: the hosts file blocks the whole site)` : "";
  return `In Chrome:  ${ids.map((id) => `${findFeedSite(id)!.name} ${findFeedSite(id)!.mode}`).join(", ")}${note}\n`;
}

async function formatSubreddits(path: string, section: FocusSection | null): Promise<string> {
  let list: Awaited<ReturnType<typeof readAllowlist>>;
  try {
    list = await readAllowlist(path);
    if (!list.found) return "";
  } catch (error) {
    return `Subreddits: ${describeError(error)}\n`;
  }
  const names = list.allow.length > 0 ? list.allow.map((name) => `r/${name}`).join(", ") : "none";
  if (!list.enabled) return `Subreddits: ${names} (off; turn it on with \`focus config\`)\n`;
  const note = section && blocksReddit(section) ? "\n            (no effect: the hosts file blocks all of Reddit)" : "";
  return `Subreddits: ${names} (allowed in Chrome)${note}\n`;
}

async function runNativeHost(io: Io): Promise<number> {
  if (io.isRoot) {
    io.stderr("focus: the Chrome extension's host doesn't run as root\n");
    return 1;
  }
  try {
    const request = await readMessage(io.nativeMessaging.input());
    const reply = await respond(request, {
      systemHostsFile: io.systemHostsFile,
      allowlistPath: io.chrome.allowlistPath,
      feedsPath: io.chrome.feedsPath,
      extensionSource: io.chrome.extensionSource,
      extensionDir: io.chrome.extensionDir,
      statsPath: io.statsPath,
      now: io.now,
      version: VERSION,
      log: io.stderr,
    });
    // Chrome reads stdout as messages, so nothing else may ever be written there.
    await io.nativeMessaging.output(encodeMessage(reply));
    return 0;
  } catch (error) {
    io.stderr(`focus: ${describeError(error)}\n`);
    return 1;
  }
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return left === right;
}

/** Has the new binary bring the extension's files up to its version, if the extension is set up. */
async function updateExtensionAfterUpgrade(binary: string, io: Io): Promise<void> {
  if (!(await isDirectory(io.chrome.extensionDir))) return;
  if ((await io.runBinary(binary, ["chrome", "update"])) !== 0) {
    io.stderr("focus: couldn't update the Chrome extension's files; run `focus chrome update`\n");
  }
}

async function isWritable(path: string): Promise<boolean> {
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

function planChange(
  command: string | undefined,
  args: string[],
  current: FocusSection | null,
  options: { exact: boolean; preset: boolean; keepEmpty: boolean },
  io: Io,
): FocusSection | null {
  const enabled = current?.presets.map((group) => group.id) ?? [];
  const sites = current?.sites ?? [];
  if (options.preset && command !== "add" && command !== "remove" && command !== "rm") {
    throw new UsageError("--preset only works with add and remove");
  }

  switch (command) {
    case "add": {
      const { ids, hosts } = options.preset ? { ids: parsePresetIds(args, command), hosts: [] } : parseTargets(args, command);
      for (const id of ids) if (enabled.includes(id)) io.stderr(`focus: the ${id} preset is already on\n`);
      // Presets first, so a host that a newly added preset covers is reported as covered.
      const next = ids.length > 0 ? withPresets(current, [...enabled, ...ids]) : current;
      for (const preset of offPresetsOwning(hosts, next)) {
        const others = preset.hosts.filter((host) => !expand(hosts, options.exact).includes(host));
        io.stderr(
          `focus: tip: \`focus add ${preset.id}\` blocks all of the ${preset.name} preset, including ${others.join(", ")}\n`,
        );
      }
      const added: string[] = [];
      for (const host of expand(hosts, options.exact)) {
        const preset = presetBlocking(next, host);
        if (preset) io.stderr(`focus: ${host} is already blocked by the ${preset.name} preset\n`);
        else if (sites.includes(host)) io.stderr(`focus: ${host} is already listed\n`);
        else added.push(host);
      }
      return { state: next?.state ?? "on", presets: next?.presets ?? [], sites: [...(next?.sites ?? []), ...added] };
    }
    case "remove":
    case "rm": {
      const { ids, hosts } = options.preset ? { ids: parsePresetIds(args, command), hosts: [] } : parseTargets(args, command);
      for (const id of ids) if (!enabled.includes(id)) io.stderr(`focus: the ${id} preset isn't on\n`);
      const next = current && ids.length > 0 ? withPresets(current, enabled.filter((id) => !ids.includes(id))) : current;
      for (const host of hosts) {
        const preset = presetBlocking(next, host);
        if (preset) {
          io.stderr(
            `focus: ${host} is blocked by the ${preset.name} preset; to unblock it, run \`focus remove ${preset.id}\`\n`,
          );
        } else if (!next?.sites.includes(host)) {
          io.stderr(`focus: ${host} is not listed\n`);
        }
      }
      const removed = expand(hosts, options.exact);
      return next && { ...next, sites: next.sites.filter((host) => !removed.includes(host)) };
    }
    case "on":
    case "off": {
      if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
      if (!current) {
        // Only Chrome settings: turning on creates the section that holds the state.
        if (options.keepEmpty) return command === "on" ? { state: "on", presets: [], sites: [] } : null;
        if (command === "on") io.stderr("focus: nothing is listed yet; run `focus init` or `focus add <host>`\n");
        return null;
      }
      return { ...current, state: command };
    }
    case undefined:
      if (!current) return options.keepEmpty ? { state: "on", presets: [], sites: [] } : null;
      return { ...current, state: current.state === "on" ? "off" : "on" };
    case "sync":
      if (args.length > 0) throw new UsageError("sync takes no arguments");
      return current;
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

/** Catalog presets, not enabled in `section`, that list one of `hosts`. */
function offPresetsOwning(hosts: string[], section: FocusSection | null): Preset[] {
  const enabled = new Set(section?.presets.map((group) => group.id));
  return PRESETS.filter((preset) => !enabled.has(preset.id) && hosts.some((host) => preset.hosts.includes(host)));
}

/** The presets `init` sets without the list: the named ones, or with --yes the current (or recommended) ones. */
function choosePresets(args: string[], yes: boolean, current: FocusSection | null): string[] {
  if (args.length > 0) return parsePresetIds(args, "init");
  if (!yes) {
    throw new UsageError("init needs an interactive terminal; name presets (e.g. `focus init x youtube`) or pass --yes");
  }
  return current?.presets.length ? current.presets.map((group) => group.id) : recommendedPresets();
}

function recommendedPresets(): string[] {
  return PRESETS.filter((preset) => preset.recommended).map((preset) => preset.id);
}

function parsePresetIds(args: string[], command: string): string[] {
  if (args.length === 0) throw new UsageError(`${command} needs at least one preset name`);
  const unknown = args.filter((id) => !findPreset(id));
  if (unknown.length > 0) throw new UsageError(unknown.map(unknownPreset).join("\n"));
  return [...new Set(args.map((id) => findPreset(id)!.id))];
}

function unknownPreset(name: string): string {
  const suggestions = suggestPresets(name);
  return suggestions.length > 0
    ? `unknown preset '${name}'; did you mean ${suggestions.map((preset) => `'${preset.id}'`).join(" or ")}?`
    : `unknown preset '${name}'; choose from: ${PRESETS.map((preset) => preset.id).join(", ")}`;
}

/**
 * Splits add/remove arguments into presets and hostnames. Hostnames always contain a
 * dot, so a single word can only mean a preset; one that isn't a preset is an error,
 * with a suggestion when it looks like a typo.
 */
function parseTargets(args: string[], command: string): { ids: string[]; hosts: string[] } {
  if (args.length === 0) throw new UsageError(`${command} needs at least one hostname or preset`);
  const errors: string[] = [];
  const ids: string[] = [];
  const hosts: string[] = [];
  for (const arg of args) {
    const preset = findPreset(arg);
    if (preset) {
      if (!ids.includes(preset.id)) ids.push(preset.id);
      continue;
    }
    try {
      const host = normalizeHostname(arg);
      if (!hosts.includes(host)) hosts.push(host);
    } catch (error) {
      if (!(error instanceof InvalidHostnameError)) throw error;
      if (!/^[\p{L}\p{N}_-]+$/u.test(arg.trim())) errors.push(error.message);
      else if (suggestPresets(arg).length > 0) errors.push(unknownPreset(arg));
      else {
        errors.push(
          `'${arg}' isn't a preset or a hostname; presets are ${PRESETS.map((p) => p.id).join(", ")}, ` +
            `and hostnames need a domain, e.g. '${arg.trim().toLowerCase()}.com'`,
        );
      }
    }
  }
  if (errors.length > 0) throw new UsageError(errors.join("\n"));
  return { ids, hosts };
}

function expand(hosts: string[], exact: boolean): string[] {
  const all = exact ? hosts : hosts.flatMap((host) => (host.startsWith("www.") ? [host] : [host, `www.${host}`]));
  return [...new Set(all)];
}

function allHosts(section: FocusSection): Set<string> {
  return new Set([...section.presets.flatMap((group) => group.hosts), ...section.sites]);
}

function formatStatus(path: string, section: FocusSection | null): string {
  if (!section) return `Hosts file: ${path}\nBlocking:   off (nothing listed)\n`;
  if (isEmpty(section)) return `Hosts file: ${path}\nBlocking:   ${section.state} (in Chrome only; nothing in the hosts file)\n`;
  const lines = [`Hosts file: ${path}`, `Blocking:   ${section.state}`];
  if (section.presets.length > 0) {
    lines.push(`Presets:    ${section.presets.map((group) => findPreset(group.id)?.name ?? group.id).join(", ")}`);
  }
  if (section.sites.length > 0) {
    lines.push(`Sites (${section.sites.length}):`, ...section.sites.map((host) => `  ${host}`));
  }
  return lines.join("\n") + "\n";
}

/**
 * A one-line status on stderr. In a terminal it redraws in place and is erased when done;
 * otherwise each new step gets its own line, and updates within a step (the download's
 * percentage) are left out so logs stay short.
 */
function statusLine(io: Io): { show(progress: { step: string; text: string }): void; clear(): void } {
  let shown: string | null = null;
  return {
    show({ step, text }) {
      if (io.stderrIsTerminal) {
        if (text !== shown) io.stderr(`\r\x1b[K${text}`);
        shown = text;
      } else if (step !== shown) {
        io.stderr(`${text}\n`);
        shown = step;
      }
    },
    clear() {
      if (io.stderrIsTerminal && shown !== null) io.stderr("\r\x1b[K");
      shown = null;
    },
  };
}

function describeProgress(event: UpgradeProgress): { step: string; text: string } {
  switch (event.step) {
    case "checking":
      return { step: event.step, text: "Checking for a new version…" };
    case "downloading": {
      const text = `Downloading focus ${event.version}…`;
      if (event.total === null) return { step: event.step, text: `${text} ${megabytes(event.received)}` };
      const percent = Math.floor((event.received / event.total) * 100);
      return { step: event.step, text: `${text} ${percent}% of ${megabytes(event.total)}` };
    }
    case "verifying":
      return { step: event.step, text: `Verifying focus ${event.version}…` };
    case "installing":
      return { step: event.step, text: `Installing focus ${event.version} at ${event.path}…` };
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatUpgrade(result: UpgradeResult): string {
  switch (result.status) {
    case "up-to-date":
      return `focus ${result.current} is up to date.\n`;
    case "available":
      return `focus ${result.latest} is available (you have ${result.current}). Run \`focus upgrade\` to install it.\n`;
    case "upgraded":
      return `Upgraded focus ${result.current} -> ${result.latest} (${result.path}).\n`;
  }
}

function formatConfig({ path, found }: LoadedConfig): string {
  return `Config:     ${path}${found ? "" : " (not found; using defaults)"}\n`;
}

function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return `\x1b[1m${line}\x1b[0m`;
      if (line.startsWith("+")) return `\x1b[32m${line}\x1b[0m`;
      if (line.startsWith("-")) return `\x1b[31m${line}\x1b[0m`;
      if (line.startsWith("@@")) return `\x1b[36m${line}\x1b[0m`;
      return line;
    })
    .join("\n");
}

function describeError(error: unknown): string {
  if (error instanceof HostsFormatError) {
    return `${error.message}\nThe focus section of the hosts file is malformed, so focus won't modify it. See "Manual recovery" in the README.`;
  }
  if (
    error instanceof ConcurrentModificationError ||
    error instanceof ConfigError ||
    error instanceof UpgradeError ||
    error instanceof SudoSetupError ||
    error instanceof SubredditError ||
    error instanceof NativeMessageError
  ) {
    return error.message;
  }
  const { code, path } = error as NodeJS.ErrnoException;
  if (code === "ENOENT") return `${path ?? "file"} not found`;
  if (code === "EACCES" || code === "EPERM") return `permission denied: ${path ?? "the hosts file"}`;
  return error instanceof Error ? error.message : String(error);
}

async function flushMacDnsCache(): Promise<void> {
  await Bun.$`dscacheutil -flushcache`.quiet();
  await Bun.$`killall -HUP mDNSResponder`.quiet();
}

async function githubToken(env: Record<string, string | undefined>): Promise<string | null> {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  // sudo drops the user's environment and root has no gh login, so ask gh as the invoking user.
  const sudoUser = process.getuid?.() === 0 && env.SUDO_USER && env.SUDO_USER !== "root" ? env.SUDO_USER : null;
  try {
    const result = sudoUser
      ? await Bun.$`sudo -u ${sudoUser} -i gh auth token`.quiet().nothrow()
      : await Bun.$`gh auth token`.quiet().nothrow();
    return result.exitCode === 0 ? result.text().trim() || null : null;
  } catch {
    return null; // gh isn't installed
  }
}

async function elevateWithSudo(argv: string[]): Promise<number> {
  // Run the binary by its real path: that's the path a `focus setup-sudo` rule names.
  const self = Bun.main.startsWith("/$bunfs/") ? [await realpath(process.execPath)] : [process.execPath, Bun.main];
  return Bun.spawn(["/usr/bin/sudo", ...self, ...argv], { stdio: ["inherit", "inherit", "inherit"] }).exited;
}

async function validateSudoers(path: string): Promise<void> {
  const result = await Bun.$`/usr/sbin/visudo -cf ${path}`.quiet().nothrow();
  if (result.exitCode !== 0) throw new SudoSetupError(`visudo rejected the rule: ${result.stderr.toString().trim()}`);
}

async function sudoAllows(user: string, binary: string): Promise<boolean> {
  const result = await Bun.$`/usr/bin/sudo -l -U ${user}`.quiet().nothrow();
  return result.stdout.toString().includes(`NOPASSWD: ${binary}`);
}

async function runBinary(path: string, args: string[]): Promise<number> {
  return Bun.spawn([path, ...args], { stdio: ["inherit", "inherit", "inherit"] }).exited;
}

async function runVersion(path: string): Promise<string> {
  const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(proc.signalCode ? `killed by ${proc.signalCode}` : `exit code ${code}`);
  return output;
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    stdoutIsTerminal: process.stdout.isTTY === true,
    stderrIsTerminal: process.stderr.isTTY === true,
    sleep: (ms) => Bun.sleep(ms),
    readKey: () => {
      const stdin = process.stdin;
      if (!stdin.isTTY) return { key: new Promise<Key>(() => {}), stop: () => {} };
      let onData: (chunk: Buffer) => void = () => {};
      const key = new Promise<Key>((resolve) => {
        onData = (chunk) => {
          if (chunk.includes(3)) resolve("interrupt");
          else if (chunk.includes(13) || chunk.includes(10)) resolve("enter");
          // A lone Esc; arrow keys and the like arrive as Esc plus more bytes.
          else if (chunk.length === 1 && chunk[0] === 27) resolve("skip");
        };
      });
      stdin.setRawMode(true);
      stdin.on("data", onData);
      stdin.resume();
      return {
        key,
        stop: () => {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
        },
      };
    },
    flushDns: flushMacDnsCache,
    chooseSites: process.stdin.isTTY && process.stdout.isTTY ? chooseSites : undefined,
    askText: process.stdin.isTTY && process.stdout.isTTY ? askText : undefined,
    upgrade: (dryRun, progress) =>
      upgrade(VERSION, dryRun, {
        progress,
        fetch,
        token: () => githubToken(process.env),
        // Compiled executables run from Bun's embedded filesystem.
        binaryPath: Bun.main.startsWith("/$bunfs/") ? process.execPath : null,
        arch: process.arch,
        runVersion,
      }),
    runBinary,
    isRoot: process.getuid?.() === 0,
    systemHostsFile: SYSTEM_HOSTS_FILE,
    elevate: elevateWithSudo,
    binaryPath: Bun.main.startsWith("/$bunfs/") ? process.execPath : null,
    sudoers: {
      path: SUDOERS_FILE,
      owner: { mode: 0o440, uid: 0, gid: 0 },
      trustedUid: 0,
      validate: validateSudoers,
      verify: sudoAllows,
    },
    chrome: {
      allowlistPath: defaultAllowlistPath(),
      feedsPath: defaultFeedsPath(),
      // `--asset ./extension` puts the files beside the compiled code; from source they're in the repo.
      extensionSource: Bun.main.startsWith("/$bunfs/") ? join(import.meta.dir, "extension") : join(import.meta.dir, "..", "extension"),
      ...defaultChromePaths(),
      reveal: async (path) => void (await Bun.$`open -R ${path}`.quiet().nothrow()),
      openInChrome: async (url) => (await Bun.$`open -a ${"Google Chrome"} ${url}`.quiet().nothrow()).exitCode === 0,
      copyToClipboard: async (text) => (await Bun.$`printf %s ${text} | pbcopy`.quiet().nothrow()).exitCode === 0,
    },
    statsPath: defaultStatsPath(),
    now: () => Date.now(),
    nativeMessaging: {
      input: () => Bun.stdin.stream(),
      output: async (bytes) => void (await Bun.write(Bun.stdout, bytes)),
    },
  });
  process.exit(code);
}
