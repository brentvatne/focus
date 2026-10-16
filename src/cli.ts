#!/usr/bin/env bun
import { access, constants, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
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
import { PRESETS, type Preset, findPreset, presetBlocking, syncSection, withPresets } from "./presets.ts";
import { promptForPresets } from "./prompt.ts";
import { UpgradeError, type UpgradeResult, upgrade } from "./upgrade.ts";
import { VERSION } from "./version.ts";

const USAGE = `Usage: focus [command] [options]

Block distracting websites by managing a marked section of /etc/hosts.

Commands:
  (none)                  Toggle blocking: on if it's off, off if it's on
  init [preset...]      Choose which presets to block. Without names, shows a checklist;
                          names set the list exactly. Presets: ${PRESETS.map((p) => p.id).join(", ")}
  add <host...>           Block hostnames (also blocks www.<host> unless --exact)
  add --preset <id...>    Turn presets on
  remove <host...>        Unblock hostnames (also unblocks www.<host> unless --exact)
  remove --preset <id...> Turn presets off
  on                      Turn blocking on for everything listed
  off                     Turn blocking off but keep the list
  status                  Show whether blocking is on and what's listed
  sync                    Update presets to this version's hostnames
  upgrade                 Install the latest release, then sync (--dry-run only checks)
  setup-sudo              Let focus get root without a password (--remove undoes it)
  version                 Print the version

Options:
  -n, --dry-run          Print a diff of the hosts file instead of writing it
  -y, --yes              init: keep the current presets (or the recommended ones) without prompting
      --preset           add/remove: the arguments are preset names, not hostnames
      --[no-]exact       Don't add or remove the www. variant (default: false)
      --hosts-file <path> Hosts file to manage (default: $FOCUS_HOSTS_FILE or /etc/hosts)
      --[no-]flush       Flush the macOS DNS cache after writing (default: true)
      --remove           setup-sudo: remove the rule instead of installing it
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
  /** Called after /etc/hosts itself (never any other file) has been rewritten. */
  flushDns(): Promise<void>;
  /** Asks which presets to block; resolves to their ids, or null if cancelled. Absent without a terminal. */
  selectPresets?(presets: Preset[], initial: string[]): Promise<string[] | null>;
  upgrade(dryRun: boolean): Promise<UpgradeResult>;
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
      const check = await io.upgrade(true);
      if (check.status !== "available") {
        io.stdout(formatUpgrade(check));
        return 0;
      }
      return elevate(argv, io);
    }
    const result = await io.upgrade(values["dry-run"] ?? false);
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
    return 0;
  }

  if (command === "setup-sudo") {
    if (args.length > 0) throw new UsageError("setup-sudo takes no arguments");
    return setupSudo(argv, { remove: values.remove ?? false, dryRun: values["dry-run"] ?? false }, io);
  }
  if (values.remove) throw new UsageError("--remove only works with setup-sudo");

  const hostsPath = values["hosts-file"] ?? io.env.FOCUS_HOSTS_FILE ?? io.systemHostsFile;
  const targetsSystemHosts = await isSameFile(hostsPath, io.systemHostsFile);
  // Passwordless sudo must not become a way to write arbitrary root-owned files.
  if (io.isRoot && !targetsSystemHosts) {
    throw new UsageError(`as root, focus only manages ${io.systemHostsFile}; --hosts-file and FOCUS_HOSTS_FILE can't point elsewhere`);
  }
  // A bare `focus` with nothing to toggle shows help instead of asking sudo for nothing.
  if (command === undefined && !readSection((await readHostsFile(hostsPath)).content)) {
    io.stdout(USAGE + "\n");
    return 0;
  }
  if (!io.isRoot && targetsSystemHosts && (command === undefined || MUTATING_COMMANDS.has(command)) && !values["dry-run"]) {
    return elevate(argv, io);
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
    io.stdout(formatConfig(loaded));
    return 0;
  }

  let next: FocusSection | null;
  if (command === "init") {
    const ids = await choosePresets(args, values.yes ?? false, current, io);
    if (ids === null) {
      io.stdout("Cancelled; nothing was changed.\n");
      return 0;
    }
    next = withPresets(current, ids);
  } else {
    next = planChange(command, args, current, { exact, preset: values.preset ?? false }, io);
  }
  if (current?.state === "off" && next && [...allHosts(next)].some((host) => !allHosts(current).has(host))) {
    io.stderr("focus: blocking is off; run `focus on` to block these sites\n");
  }

  const updated = writeSection(snapshot.content, next);
  if (updated === snapshot.content) {
    io.stdout(`No changes to ${snapshot.path}.\n`);
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
  io.stdout(formatStatus(snapshot.path, next));
  io.stdout(`Previous version saved to ${backupPath(snapshot)}.\n`);

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

async function isSameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return left === right;
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
  options: { exact: boolean; preset: boolean },
  io: Io,
): FocusSection | null {
  const enabled = current?.presets.map((group) => group.id) ?? [];
  const sites = current?.sites ?? [];
  if (options.preset && command !== "add" && command !== "remove" && command !== "rm") {
    throw new UsageError("--preset only works with add and remove");
  }

  switch (command) {
    case "add": {
      if (options.preset) {
        const ids = parsePresetIds(args, command);
        for (const id of ids) if (enabled.includes(id)) io.stderr(`focus: the ${id} preset is already on\n`);
        return withPresets(current, [...enabled, ...ids]);
      }
      const added: string[] = [];
      for (const host of expand(parseHostnames(args, command), options.exact)) {
        const preset = presetBlocking(current, host);
        if (preset) io.stderr(`focus: ${host} is already blocked by the ${preset.name} preset\n`);
        else if (sites.includes(host)) io.stderr(`focus: ${host} is already listed\n`);
        else added.push(host);
      }
      return { state: current?.state ?? "on", presets: current?.presets ?? [], sites: [...sites, ...added] };
    }
    case "remove":
    case "rm": {
      if (options.preset) {
        const ids = parsePresetIds(args, command);
        for (const id of ids) if (!enabled.includes(id)) io.stderr(`focus: the ${id} preset isn't on\n`);
        return current && withPresets(current, enabled.filter((id) => !ids.includes(id)));
      }
      const requested = parseHostnames(args, command);
      for (const host of requested) {
        const preset = presetBlocking(current, host);
        if (preset) {
          io.stderr(
            `focus: ${host} is blocked by the ${preset.name} preset; to unblock it, run \`focus remove --preset ${preset.id}\`\n`,
          );
        } else if (!sites.includes(host)) {
          io.stderr(`focus: ${host} is not listed\n`);
        }
      }
      const hosts = expand(requested, options.exact);
      return current && { ...current, sites: sites.filter((host) => !hosts.includes(host)) };
    }
    case "on":
    case "off": {
      if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
      if (!current) {
        if (command === "on") io.stderr("focus: nothing is listed yet; run `focus init` or `focus add <host>`\n");
        return null;
      }
      return { ...current, state: command };
    }
    case undefined:
      return current && { ...current, state: current.state === "on" ? "off" : "on" };
    case "sync":
      if (args.length > 0) throw new UsageError("sync takes no arguments");
      return current;
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

async function choosePresets(
  args: string[],
  yes: boolean,
  current: FocusSection | null,
  io: Io,
): Promise<string[] | null> {
  if (args.length > 0) return parsePresetIds(args, "init");
  const initial = current?.presets.length
    ? current.presets.map((group) => group.id)
    : PRESETS.filter((preset) => preset.recommended).map((preset) => preset.id);
  if (yes) return initial;
  if (!io.selectPresets) {
    throw new UsageError("init needs an interactive terminal; name presets (e.g. `focus init x youtube`) or pass --yes");
  }
  return io.selectPresets(PRESETS, initial);
}

function parsePresetIds(args: string[], command: string): string[] {
  if (args.length === 0) throw new UsageError(`${command} --preset needs at least one preset name`);
  const unknown = args.filter((id) => !findPreset(id));
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown preset ${unknown.map((id) => `'${id}'`).join(", ")}; choose from: ${PRESETS.map((p) => p.id).join(", ")}`,
    );
  }
  return [...new Set(args.map((id) => findPreset(id)!.id))];
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

function allHosts(section: FocusSection): Set<string> {
  return new Set([...section.presets.flatMap((group) => group.hosts), ...section.sites]);
}

function formatStatus(path: string, section: FocusSection | null): string {
  if (!section || isEmpty(section)) {
    return `Hosts file: ${path}\nBlocking:   off (nothing listed)\n`;
  }
  const lines = [`Hosts file: ${path}`, `Blocking:   ${section.state}`];
  if (section.presets.length > 0) {
    lines.push(`Presets:    ${section.presets.map((group) => findPreset(group.id)?.name ?? group.id).join(", ")}`);
  }
  if (section.sites.length > 0) {
    lines.push(`Sites (${section.sites.length}):`, ...section.sites.map((host) => `  ${host}`));
  }
  return lines.join("\n") + "\n";
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
    error instanceof SudoSetupError
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
  });
  process.exit(code);
}
