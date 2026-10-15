#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ConfigError, type LoadedConfig, loadConfig, resolveConfigPath } from "./config.ts";
import { unifiedDiff } from "./diff.ts";
import { InvalidHostnameError, normalizeHostname } from "./hostname.ts";
import { type FocusSection, HostsFormatError, readSection, writeSection } from "./hosts.ts";
import {
  ConcurrentModificationError,
  SYSTEM_HOSTS_FILE,
  backupPath,
  readHostsFile,
  writeHostsFile,
} from "./hostsfile.ts";
import { PRESETS, type Preset, findPreset } from "./presets.ts";
import { promptForPresets } from "./prompt.ts";
import { UpgradeError, type UpgradeResult, upgrade } from "./upgrade.ts";
import { VERSION } from "./version.ts";

const USAGE = `Usage: focus <command> [options]

Block distracting websites by managing a marked section of /etc/hosts.

Commands:
  init [preset...]   Pick sites to block from a list of presets (${PRESETS.map((p) => p.id).join(", ")})
  add <host...>      Block hostnames (also blocks www.<host> unless --exact)
  remove <host...>   Unblock hostnames (also unblocks www.<host> unless --exact)
  on                 Turn blocking on for every listed site
  off                Turn blocking off but keep the list
  status             Show whether blocking is on and which sites are listed
  upgrade            Replace this binary with the latest release (--dry-run only checks)
  version            Print the version

Options:
  -n, --dry-run          Print a diff of the hosts file instead of writing it
  -y, --yes              init: use the recommended presets without prompting
      --[no-]exact       Don't add or remove the www. variant (default: false)
      --hosts-file <path> Hosts file to manage (default: $FOCUS_HOSTS_FILE or /etc/hosts)
      --[no-]flush       Flush the macOS DNS cache after writing (default: true)
  -h, --help             Show this help
  -v, --version          Print the version

Config:
  Defaults for --exact and --flush can be set in ~/.config/focus/config.json
  (or $XDG_CONFIG_HOME/focus/config.json, or $FOCUS_CONFIG). Under sudo, ~ is
  your home, not root's. Example: { "exact": true, "flushDns": false }

Changing /etc/hosts requires root: run with sudo.`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  color: boolean;
  /** Called after /etc/hosts itself (never any other file) has been rewritten. */
  flushDns(): Promise<void>;
  /** Asks which presets to add; resolves to their ids, or null if cancelled. Absent without a terminal. */
  selectPresets?(presets: Preset[], listed: string[]): Promise<string[] | null>;
  upgrade(dryRun: boolean): Promise<UpgradeResult>;
}

class UsageError extends Error {}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await runCommand(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`focus: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    io.stderr(`focus: ${describeError(error)}\n`);
    return 1;
  }
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
        flush: { type: "boolean" },
        help: { type: "boolean", short: "h" },
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
  if (values.help || command === undefined || command === "help") {
    io.stdout(USAGE + "\n");
    return 0;
  }
  if (command === "upgrade" || command === "self-update") {
    if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
    io.stdout(formatUpgrade(await io.upgrade(values["dry-run"] ?? false)));
    return 0;
  }

  const loaded = await loadConfig(await resolveConfigPath(io.env));
  const exact = values.exact ?? loaded.config.exact;
  const flush = values.flush ?? loaded.config.flushDns;

  const hostsPath = values["hosts-file"] ?? io.env.FOCUS_HOSTS_FILE ?? SYSTEM_HOSTS_FILE;
  const snapshot = await readHostsFile(hostsPath);
  const current = readSection(snapshot.content);

  if (command === "status") {
    if (args.length > 0) throw new UsageError("status takes no arguments");
    io.stdout(formatStatus(snapshot.path, current) + formatConfig(loaded));
    return 0;
  }

  let next: FocusSection | null;
  if (command === "init") {
    const presets = await choosePresets(args, values.yes ?? false, current?.hosts ?? [], io);
    if (presets === null) {
      io.stdout("Cancelled; nothing was changed.\n");
      return 0;
    }
    next = planAdd(presets.flatMap((preset) => preset.hosts), current, io, { warnIfListed: false });
  } else {
    next = planChange(command, args, current, exact, io);
  }
  const updated = writeSection(snapshot.content, next);

  if (updated === snapshot.content) {
    io.stdout(`No changes to ${snapshot.path}.\n`);
    return 0;
  }

  if (values["dry-run"]) {
    const diff = unifiedDiff(snapshot.content, updated, snapshot.path, `${snapshot.path} (after focus ${command})`);
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
  io.stdout(formatStatus(snapshot.path, next));
  io.stdout(`Previous version saved to ${backupPath(snapshot)}.\n`);

  if (flush && snapshot.path === (await realpath(SYSTEM_HOSTS_FILE).catch(() => null))) {
    try {
      await io.flushDns();
    } catch (error) {
      io.stderr(`focus: warning: couldn't flush the DNS cache (${describeError(error)}). Changes may take a minute to apply.\n`);
    }
  }
  return 0;
}

function planChange(
  command: string,
  args: string[],
  current: FocusSection | null,
  exact: boolean,
  io: Io,
): FocusSection | null {
  const state = current?.state ?? "on";
  const listed = current?.hosts ?? [];

  switch (command) {
    case "add":
      return planAdd(expand(parseHostnames(args, command), exact), current, io, { warnIfListed: true });
    case "remove":
    case "rm": {
      const requested = parseHostnames(args, command);
      for (const host of requested) if (!listed.includes(host)) io.stderr(`focus: ${host} is not listed\n`);
      const hosts = expand(requested, exact);
      return current && { state, hosts: listed.filter((host) => !hosts.includes(host)) };
    }
    case "on":
    case "off": {
      if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
      if (!current) {
        if (command === "on") io.stderr("focus: no sites are listed yet; add one with `focus add <host>`\n");
        return null;
      }
      return { state: command, hosts: listed };
    }
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

function planAdd(
  hosts: string[],
  current: FocusSection | null,
  io: Io,
  { warnIfListed }: { warnIfListed: boolean },
): FocusSection {
  const state = current?.state ?? "on";
  const listed = current?.hosts ?? [];
  const added = [...new Set(hosts)].filter((host) => !listed.includes(host));
  if (warnIfListed) {
    for (const host of hosts) if (!added.includes(host)) io.stderr(`focus: ${host} is already listed\n`);
  }
  if (added.length > 0 && state === "off") {
    io.stderr("focus: blocking is off; run `focus on` to block these sites\n");
  }
  return { state, hosts: [...listed, ...added] };
}

async function choosePresets(args: string[], yes: boolean, listed: string[], io: Io): Promise<Preset[] | null> {
  if (args.length > 0) {
    const unknown = args.filter((id) => !findPreset(id));
    if (unknown.length > 0) {
      throw new UsageError(
        `unknown preset ${unknown.map((id) => `'${id}'`).join(", ")}; choose from: ${PRESETS.map((p) => p.id).join(", ")}`,
      );
    }
    return [...new Set(args.map((id) => findPreset(id)!))];
  }
  if (yes) return PRESETS.filter((preset) => preset.recommended);
  if (!io.selectPresets) {
    throw new UsageError("init needs an interactive terminal; name presets (e.g. `focus init x youtube`) or pass --yes");
  }
  const ids = await io.selectPresets(PRESETS, listed);
  return ids && PRESETS.filter((preset) => ids.includes(preset.id));
}

function parseHostnames(args: string[], command: string): string[] {
  if (args.length === 0) throw new UsageError(`${command} needs at least one hostname`);
  const errors: string[] = [];
  const hosts: string[] = [];
  for (const arg of args) {
    try {
      const host = normalizeHostname(arg);
      if (!hosts.includes(host)) hosts.push(host);
    } catch (error) {
      if (!(error instanceof InvalidHostnameError)) throw error;
      errors.push(error.message);
    }
  }
  if (errors.length > 0) throw new UsageError(errors.join("\n"));
  return hosts;
}

function expand(hosts: string[], exact: boolean): string[] {
  const all = exact ? hosts : hosts.flatMap((host) => (host.startsWith("www.") ? [host] : [host, `www.${host}`]));
  return [...new Set(all)];
}

function formatStatus(path: string, section: FocusSection | null): string {
  if (!section || section.hosts.length === 0) {
    return `Hosts file: ${path}\nBlocking:   off (no sites listed)\n`;
  }
  const lines = [
    `Hosts file: ${path}`,
    `Blocking:   ${section.state}`,
    `Sites (${section.hosts.length}):`,
    ...section.hosts.map((host) => `  ${host}`),
  ];
  return lines.join("\n") + "\n";
}

function formatUpgrade(result: UpgradeResult): string {
  switch (result.status) {
    case "up-to-date":
      return `focus ${result.current} is up to date.\n`;
    case "available":
      return `focus ${result.latest} is available (you have ${result.current}). Run \`sudo focus upgrade\` to install it.\n`;
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
    error instanceof UpgradeError
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
    flushDns: flushMacDnsCache,
    selectPresets: process.stdin.isTTY && process.stdout.isTTY ? promptForPresets : undefined,
    upgrade: (dryRun) =>
      upgrade(VERSION, dryRun, {
        fetch,
        token: () => githubToken(process.env),
        // Compiled executables run from Bun's embedded filesystem.
        binaryPath: Bun.main.startsWith("/$bunfs/") ? process.execPath : null,
        arch: process.arch,
        runVersion,
      }),
  });
  process.exit(code);
}
