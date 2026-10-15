import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "../src/cli.ts";
import { UpgradeError } from "../src/upgrade.ts";

const ORIGINAL = `##
# Host Database
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost
`;

let dir: string;
let hostsFile: string;
let configFile: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "focus-test-")));
  hostsFile = join(dir, "hosts");
  configFile = join(dir, "config.json");
  await Bun.write(hostsFile, ORIGINAL);
  await chmod(hostsFile, 0o644);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const focus = (...argv: string[]) => focusWith({}, ...argv);

async function focusWith(overrides: Partial<Io>, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  let flushes = 0;
  const io: Io = {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    // Always point at temp files so tests can never fall through to /etc/hosts or the real user config.
    env: { FOCUS_HOSTS_FILE: hostsFile, FOCUS_CONFIG: configFile },
    color: false,
    flushDns: async () => void flushes++,
    upgrade: async () => {
      throw new Error("tests must stub upgrade; it would reach GitHub");
    },
    runBinary: async () => {
      throw new Error("tests must stub runBinary");
    },
    isRoot: false,
    // A path that doesn't exist, so nothing can fall through to the real /etc/hosts.
    systemHostsFile: join(dir, "system-hosts"),
    elevate: async () => {
      throw new Error("tests must stub elevate; it would run sudo");
    },
    binaryPath: null,
    sudoers: {
      path: join(dir, "sudoers-focus"),
      owner: { mode: 0o440, uid: process.getuid!(), gid: process.getgid!() },
      trustedUid: process.getuid!(),
      validate: async () => {
        throw new Error("tests must stub sudoers.validate");
      },
      verify: async () => {
        throw new Error("tests must stub sudoers.verify");
      },
    },
    ...overrides,
  };
  const code = await run(argv, io);
  return { code, stdout, stderr, flushes };
}

const read = () => Bun.file(hostsFile).text();

describe("add", () => {
  test("blocks the host and its www variant over IPv4 and IPv6", async () => {
    const result = await focus("add", "YouTube.com");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Blocking:   on");
    const content = await read();
    expect(content.startsWith(ORIGINAL)).toBe(true);
    for (const line of ["0.0.0.0 youtube.com", ":: youtube.com", "0.0.0.0 www.youtube.com", ":: www.youtube.com"]) {
      expect(content.split("\n")).toContain(line);
    }
  });

  test("--exact skips the www variant", async () => {
    await focus("add", "--exact", "news.ycombinator.com");
    expect(await read()).not.toContain("www.news.ycombinator.com");
  });

  test("saves the previous contents as a backup", async () => {
    await focus("add", "a.com");
    expect(await Bun.file(`${hostsFile}.focus-backup`).text()).toBe(ORIGINAL);
  });

  test("is a no-op for hosts that are already listed", async () => {
    await focus("add", "a.com");
    const before = await read();
    const result = await focus("add", "a.com");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No changes");
    expect(result.stderr).toContain("a.com is already listed");
    expect(await read()).toBe(before);
  });

  test("rejects invalid hostnames without writing anything", async () => {
    const result = await focus("add", "good.com", "localhost", "https://reddit.com/r/all");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("'localhost'");
    expect(result.stderr).toContain("Did you mean 'reddit.com'?");
    expect(await read()).toBe(ORIGINAL);
    expect(await Bun.file(`${hostsFile}.focus-backup`).exists()).toBe(false);
  });

  test("keeps new sites inactive while blocking is off", async () => {
    await focus("add", "a.com");
    await focus("off");
    const result = await focus("add", "b.com");
    expect(result.stderr).toContain("blocking is off");
    expect(await read()).toContain("# 0.0.0.0 b.com");
  });
});

describe("remove", () => {
  test("removing the last site restores the original file exactly", async () => {
    await focus("add", "a.com", "b.com");
    await focus("off");
    expect((await focus("remove", "a.com")).code).toBe(0);
    expect((await focus("rm", "b.com")).code).toBe(0);
    expect(await read()).toBe(ORIGINAL);
  });

  test("--exact leaves the www variant in place", async () => {
    await focus("add", "a.com");
    await focus("remove", "--exact", "a.com");
    expect((await focus("status")).stdout).toContain("Sites (1):\n  www.a.com\n");
  });

  test("warns about hosts that aren't listed", async () => {
    const result = await focus("remove", "nope.com");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("nope.com is not listed");
    expect(await read()).toBe(ORIGINAL);
  });
});

describe("on / off / status", () => {
  test("off comments entries out and on restores them", async () => {
    await focus("add", "a.com");
    const blocked = await read();

    expect((await focus("off")).code).toBe(0);
    const unblocked = await read();
    expect(unblocked).toContain("# 0.0.0.0 a.com");
    expect(unblocked).toContain("# :: a.com");
    expect(unblocked.split("\n").filter((line) => /^(0\.0\.0\.0|::) /.test(line))).toEqual([]);
    expect((await focus("status")).stdout).toContain("Blocking:   off");

    expect((await focus("on")).code).toBe(0);
    expect(await read()).toBe(blocked);
    expect((await focus("status")).stdout).toBe(
      `Hosts file: ${hostsFile}\nBlocking:   on\nSites (2):\n  a.com\n  www.a.com\n` +
        `Config:     ${configFile} (not found; using defaults)\n`,
    );
  });

  test("on with nothing listed changes nothing", async () => {
    const result = await focus("on");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("nothing is listed yet");
    expect(await read()).toBe(ORIGINAL);
  });

  test("status reports when nothing is set up", async () => {
    expect((await focus("status")).stdout).toBe(
      `Hosts file: ${hostsFile}\nBlocking:   off (nothing listed)\n` +
        `Config:     ${configFile} (not found; using defaults)\n`,
    );
  });
});

describe("--dry-run", () => {
  test("prints a diff and leaves the file and its metadata untouched", async () => {
    const before = await stat(hostsFile);
    const result = await focus("add", "--dry-run", "a.com");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`--- ${hostsFile}\n+++ ${hostsFile} (after focus add)\n@@ -4,3 +4,12 @@`);
    expect(result.stdout).toContain("+0.0.0.0 a.com\n+:: a.com\n");
    expect(result.stdout).toContain("Dry run:");
    expect(await read()).toBe(ORIGINAL);
    expect((await stat(hostsFile)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(dir)).toEqual(["hosts"]);
    expect(result.flushes).toBe(0);
  });

  test("-n works for off", async () => {
    await focus("add", "--exact", "a.com");
    const result = await focus("-n", "off");
    expect(result.stdout).toContain(
      "-# state: on\n+# state: off\n # sites\n-0.0.0.0 a.com\n-:: a.com\n+# 0.0.0.0 a.com\n+# :: a.com\n",
    );
    expect((await focus("status")).stdout).toContain("Blocking:   on");
  });
});

describe("file handling", () => {
  test.each([0o644, 0o600, 0o664])("preserves mode %o", async (mode) => {
    await chmod(hostsFile, mode);
    await focus("add", "a.com");
    expect((await stat(hostsFile)).mode & 0o7777).toBe(mode);
    expect((await stat(`${hostsFile}.focus-backup`)).mode & 0o7777).toBe(mode);
  });

  test("writes through a symlink instead of replacing it", async () => {
    const link = join(dir, "hosts-link");
    await symlink(hostsFile, link);
    const result = await focus("--hosts-file", link, "add", "a.com");
    expect(result.code).toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await read()).toContain("0.0.0.0 a.com");
  });

  test("leaves no temp files behind", async () => {
    await focus("add", "a.com");
    await focus("off");
    expect((await readdir(dir)).sort()).toEqual(["hosts", "hosts.focus-backup"]);
  });

  test("never flushes DNS for a file other than /etc/hosts", async () => {
    expect((await focus("add", "a.com")).flushes).toBe(0);
  });

  test("refuses to touch a malformed focus section", async () => {
    const broken = `${ORIGINAL}# BEGIN focus\n0.0.0.0 a.com\n`;
    await Bun.write(hostsFile, broken);
    for (const argv of [["add", "b.com"], ["off"], ["status"]]) {
      const result = await focus(...argv);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Manual recovery");
    }
    expect(await read()).toBe(broken);
  });

  test("reports a missing hosts file", async () => {
    const result = await focus("--hosts-file", join(dir, "missing"), "status");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  test("reports a permission error and leaves the file alone", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    await chmod(dir, 0o555);
    try {
      const result = await focus("add", "a.com");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("permission denied");
      expect(result.stderr).toContain("sudo");
    } finally {
      await chmod(dir, 0o755);
    }
    expect(await read()).toBe(ORIGINAL);
  });
});

describe("init", () => {
  const presetsLine = async () => (await focus("status")).stdout.split("\n").find((line) => line.startsWith("Presets:"));

  test("--yes turns on the recommended presets, but not Messenger", async () => {
    expect((await focus("init", "--yes")).code).toBe(0);
    expect(await presetsLine()).toBe("Presets:    X / Twitter, Facebook, YouTube, Reddit");
    const content = await read();
    for (const host of ["api.x.com", "facebook.com", "youtu.be", "old.reddit.com"]) {
      expect(content).toContain(`0.0.0.0 ${host}\n`);
    }
    expect(content).not.toContain("messenger.com");
  });

  test("writes each preset under its own header, without the www expansion", async () => {
    await focus("init", "youtube");
    expect(await read()).toContain(
      "# preset: youtube\n" +
        ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].map((h) => `0.0.0.0 ${h}\n:: ${h}\n`).join(""),
    );
  });

  test("named presets replace the current ones and skip the prompt", async () => {
    await focus("init", "--yes");
    let prompted = false;
    const selectPresets = async () => ((prompted = true), []);
    expect((await focusWith({ selectPresets }, "init", "messenger", "Reddit")).code).toBe(0);
    expect(prompted).toBe(false);
    expect(await presetsLine()).toBe("Presets:    Reddit, Messenger");
    expect(await read()).not.toContain("facebook.com");
  });

  test("the checklist starts from the current presets, and unchecking one removes it", async () => {
    await focus("init", "x", "youtube");
    await focus("add", "a.com");
    let initial: string[] = [];
    const selectPresets = async (_: unknown, current: string[]) => ((initial = current), ["youtube", "hackernews"]);
    expect((await focusWith({ selectPresets }, "init")).code).toBe(0);
    expect(initial).toEqual(["x", "youtube"]);
    expect(await presetsLine()).toBe("Presets:    YouTube, Hacker News");
    expect(await read()).not.toContain("x.com");
    expect((await focus("status")).stdout).toContain("Sites (2):\n  a.com\n  www.a.com\n");
  });

  test("the checklist starts from the recommended presets on a fresh install", async () => {
    let initial: string[] = [];
    await focusWith({ selectPresets: async (_: unknown, current: string[]) => ((initial = current), null) }, "init");
    expect(initial).toEqual(["x", "facebook", "youtube", "reddit"]);
  });

  test("unchecking every preset restores the original file", async () => {
    await focus("init", "--yes");
    expect((await focusWith({ selectPresets: async () => [] }, "init")).code).toBe(0);
    expect(await read()).toBe(ORIGINAL);
  });

  test("cancelling the prompt changes nothing", async () => {
    const result = await focusWith({ selectPresets: async () => null }, "init");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cancelled");
    expect(await read()).toBe(ORIGINAL);
  });

  test("asks for preset names or --yes without a terminal", async () => {
    const result = await focus("init");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--yes");
    expect(await read()).toBe(ORIGINAL);
  });

  test("rejects unknown presets", async () => {
    const result = await focus("init", "youtube", "myspace");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown preset 'myspace'");
    expect(await read()).toBe(ORIGINAL);
  });

  test("--yes keeps the current presets", async () => {
    await focus("init", "hackernews");
    const before = await read();
    const result = await focus("init", "--yes");
    expect(result.stdout).toContain("No changes");
    expect(result.stderr).toBe("");
    expect(await read()).toBe(before);
  });

  test("respects --dry-run", async () => {
    const result = await focus("init", "--yes", "--dry-run");
    expect(result.stdout).toContain("+0.0.0.0 twitter.com\n+:: twitter.com\n");
    expect(await read()).toBe(ORIGINAL);
  });
});

describe("presets with add and remove", () => {
  test("add --preset and remove --preset toggle single presets", async () => {
    await focus("add", "a.com");
    expect((await focus("add", "--preset", "instagram", "x")).code).toBe(0);
    expect((await focus("status")).stdout).toContain("Presets:    X / Twitter, Instagram\n");
    expect((await focus("remove", "--preset", "x")).code).toBe(0);
    expect((await focus("status")).stdout).toContain("Presets:    Instagram\nSites (2):");
    const result = await focus("rm", "--preset", "x");
    expect(result.stderr).toContain("the x preset isn't on");
  });

  test("won't remove one host of a preset and says how to remove the preset", async () => {
    await focus("init", "x");
    const before = await read();
    const result = await focus("remove", "api.x.com");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("api.x.com is blocked by the X / Twitter preset");
    expect(result.stderr).toContain("focus remove --preset x");
    expect(await read()).toBe(before);
  });

  test("adding a host a preset already blocks is a no-op", async () => {
    await focus("init", "youtube");
    const result = await focus("add", "youtube.com");
    expect(result.stderr).toContain("youtube.com is already blocked by the YouTube preset");
    expect(result.stdout).toContain("No changes");
  });

  test("--preset only works with add and remove", async () => {
    expect((await focus("on", "--preset")).code).toBe(2);
  });
});

describe("sync", () => {
  // What `focus init --yes` wrote with 0.1.0, followed by a site added by hand.
  const V0_1_0_SECTION = [
    "# BEGIN focus",
    "# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.",
    "# state: on",
    ...["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].flatMap((h) => [
      `0.0.0.0 ${h}`,
      `:: ${h}`,
    ]),
    ...["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].flatMap((h) => [`0.0.0.0 ${h}`, `:: ${h}`]),
    "0.0.0.0 a.com",
    ":: a.com",
    "# END focus",
    "",
  ].join("\n");

  test("converts a 0.1.0 section to presets and adds their new hosts", async () => {
    await Bun.write(hostsFile, ORIGINAL + V0_1_0_SECTION);
    const stale = await focus("status");
    expect(stale.stdout).toContain("Presets:    X / Twitter, YouTube\n");
    expect(stale.stdout).toContain("Sync:       needed");

    const result = await focus("sync");
    expect(result.code).toBe(0);
    const content = await read();
    expect(content).toContain("# preset: x\n");
    expect(content).toContain("0.0.0.0 api.x.com\n:: api.x.com\n0.0.0.0 twitter.com\n");
    expect(content).toContain("# sites\n0.0.0.0 a.com\n:: a.com\n# END focus\n");
    expect(content.startsWith(ORIGINAL)).toBe(true);
    expect((await focus("status")).stdout).not.toContain("Sync:");
    expect((await focus("sync")).stdout).toContain("No changes");
  });

  test("any write also syncs", async () => {
    await Bun.write(hostsFile, ORIGINAL + V0_1_0_SECTION);
    await focus("add", "b.com");
    expect(await read()).toContain("0.0.0.0 api.twitter.com\n");
  });

  test("keeps blocking off while syncing", async () => {
    await Bun.write(hostsFile, ORIGINAL + V0_1_0_SECTION);
    await focus("off");
    await focus("sync");
    expect(await read()).toContain("# 0.0.0.0 api.x.com\n");
    expect((await focus("status")).stdout).toContain("Blocking:   off");
  });
});

describe("version and upgrade", () => {
  test.each([["--version"], ["-v"], ["version"]])("%s prints the version", async (arg) => {
    const result = await focus(arg);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${(await Bun.file(join(import.meta.dir, "../package.json")).json()).version}\n`);
  });

  test.each([
    [{ status: "up-to-date", current: "0.1.0" }, "focus 0.1.0 is up to date.\n"],
    [{ status: "available", current: "0.1.0", latest: "0.2.0" }, "focus 0.2.0 is available (you have 0.1.0)"],
  ] as const)("reports %o without syncing", async (outcome, message) => {
    const result = await focusWith({ upgrade: async () => outcome }, "upgrade");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(message);
  });

  const upgraded = async () => ({
    status: "upgraded" as const,
    current: "0.1.0",
    latest: "0.2.0",
    path: "/usr/local/bin/focus",
  });

  test("has the new binary sync presets after upgrading", async () => {
    const calls: [string, string[]][] = [];
    const runBinary = async (path: string, args: string[]) => (calls.push([path, args]), 0);
    const result = await focusWith({ upgrade: upgraded, runBinary }, "upgrade");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Upgraded focus 0.1.0 -> 0.2.0");
    expect(calls).toEqual([["/usr/local/bin/focus", ["sync"]]]);
  });

  test("passes --hosts-file and --no-flush on to the sync", async () => {
    const calls: string[][] = [];
    const runBinary = async (_: string, args: string[]) => (calls.push(args), 0);
    await focusWith({ upgrade: upgraded, runBinary }, "upgrade", "--hosts-file", "/tmp/h", "--no-flush");
    expect(calls).toEqual([["sync", "--hosts-file", "/tmp/h", "--no-flush"]]);
  });

  test("fails if the sync after upgrading fails", async () => {
    const result = await focusWith({ upgrade: upgraded, runBinary: async () => 1 }, "upgrade");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run `focus sync`");
  });

  test("--dry-run only checks", async () => {
    let seen: boolean | undefined;
    const upgrade = async (dryRun: boolean) => ((seen = dryRun), { status: "up-to-date" as const, current: "0.1.0" });
    await focusWith({ upgrade }, "self-update", "-n");
    expect(seen).toBe(true);
  });

  test("doesn't need a readable config or hosts file", async () => {
    await Bun.write(configFile, "broken");
    const upgrade = async () => ({ status: "up-to-date" as const, current: "0.1.0" });
    const result = await focusWith({ upgrade }, "--hosts-file", join(dir, "missing"), "upgrade");
    expect(result.code).toBe(0);
  });

  test("reports upgrade failures", async () => {
    const upgrade = async () => {
      throw new UpgradeError("checksum mismatch for focus-darwin-arm64; nothing was replaced");
    };
    const result = await focusWith({ upgrade }, "upgrade");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("focus: checksum mismatch for focus-darwin-arm64; nothing was replaced\n");
  });
});

describe("running without typing sudo", () => {
  // These tests treat the temp hosts file as the system one.
  const asSystem = (overrides: Partial<Io> = {}) => ({
    systemHostsFile: hostsFile,
    env: { FOCUS_CONFIG: configFile },
    ...overrides,
  });

  test("asks sudo to rerun commands that change the system hosts file", async () => {
    const calls: string[][] = [];
    const elevate = async (argv: string[]) => (calls.push(argv), 0);
    const result = await focusWith(asSystem({ elevate }), "add", "--exact", "a.com");
    expect(result.code).toBe(0);
    expect(calls).toEqual([["add", "--exact", "a.com"]]);
    expect(result.stderr).toContain("Run `focus setup-sudo` once to skip the password");
    expect(await read()).toBe(ORIGINAL);
  });

  test("passes sudo's exit code through", async () => {
    expect((await focusWith(asSystem({ elevate: async () => 1 }), "off")).code).toBe(1);
  });

  test("skips the hint once the sudoers rule is installed", async () => {
    await Bun.write(join(dir, "sudoers-focus"), "rule");
    const result = await focusWith(asSystem({ elevate: async () => 0 }), "on");
    expect(result.stderr).toBe("");
  });

  test("doesn't need root for status or dry runs", async () => {
    expect((await focusWith(asSystem(), "status")).code).toBe(0);
    const dry = await focusWith(asSystem(), "add", "-n", "a.com");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("+0.0.0.0 a.com");
  });

  test("never elevates for other hosts files", async () => {
    expect((await focus("add", "a.com")).code).toBe(0);
  });

  test("as root, writes the system hosts file directly and flushes DNS", async () => {
    const result = await focusWith(asSystem({ isRoot: true }), "add", "a.com");
    expect(result.code).toBe(0);
    expect(result.flushes).toBe(1);
    expect(await read()).toContain("0.0.0.0 a.com\n");
  });

  test("as root, refuses any other hosts file", async () => {
    const result = await focusWith({ isRoot: true }, "add", "a.com");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("as root, focus only manages");
    expect(await read()).toBe(ORIGINAL);
  });

  test("as root, --hosts-file is fine when it is the system hosts file", async () => {
    expect((await focusWith(asSystem({ isRoot: true }), "--hosts-file", hostsFile, "add", "a.com")).code).toBe(0);
  });

  test("under sudo, only reads a config file the invoking user owns", async () => {
    await Bun.write(configFile, JSON.stringify({ exact: true }));
    const env = (uid: number) => ({ FOCUS_CONFIG: configFile, SUDO_UID: String(uid) });
    const stranger = await focusWith(asSystem({ isRoot: true, env: env(process.getuid!() + 1) }), "add", "a.com");
    expect(stranger.code).toBe(1);
    expect(stranger.stderr).toContain("must be owned by you");
    expect(await read()).toBe(ORIGINAL);

    expect((await focusWith(asSystem({ isRoot: true, env: env(process.getuid!()) }), "add", "a.com")).code).toBe(0);
    expect(await read()).not.toContain("www.a.com");
  });

  describe("upgrade", () => {
    const available = async () => ({ status: "available" as const, current: "0.1.0", latest: "0.2.0" });

    test("asks sudo only once a newer release exists and the binary isn't writable", async () => {
      await mkdir(join(dir, "bin"));
      await Bun.write(join(dir, "bin", "focus"), "binary");
      await chmod(join(dir, "bin"), 0o555);
      try {
        const seen: boolean[] = [];
        const calls: string[][] = [];
        const binaryPath = join(dir, "bin", "focus");
        const upgrade = async (dryRun: boolean) => (seen.push(dryRun), available());
        const elevate = async (argv: string[]) => (calls.push(argv), 0);
        expect((await focusWith({ binaryPath, upgrade, elevate }, "upgrade")).code).toBe(0);
        expect(seen).toEqual([true]);
        expect(calls).toEqual([["upgrade"]]);

        const upToDate = async () => ({ status: "up-to-date" as const, current: "0.2.0" });
        const result = await focusWith({ binaryPath, upgrade: upToDate }, "upgrade");
        expect(result.stdout).toBe("focus 0.2.0 is up to date.\n");
      } finally {
        await chmod(join(dir, "bin"), 0o755);
      }
    });

    test("doesn't ask when the binary's directory is writable", async () => {
      await Bun.write(join(dir, "focus-binary"), "binary");
      const seen: boolean[] = [];
      const upgrade = async (dryRun: boolean) => (seen.push(dryRun), { status: "up-to-date" as const, current: "0.1.0" });
      await focusWith({ binaryPath: join(dir, "focus-binary"), upgrade }, "upgrade");
      expect(seen).toEqual([false]);
    });
  });
});

describe("setup-sudo", () => {
  let binary: string;
  beforeEach(async () => {
    await mkdir(join(dir, "bin"));
    binary = join(dir, "bin", "focus");
    await Bun.write(binary, "binary");
    await chmod(binary, 0o755);
  });

  const asRoot = (overrides: Partial<Io["sudoers"]> = {}): Partial<Io> => ({
    isRoot: true,
    binaryPath: binary,
    env: { FOCUS_CONFIG: configFile, SUDO_USER: "brent" },
    sudoers: {
      path: join(dir, "sudoers-focus"),
      owner: { mode: 0o440, uid: process.getuid!(), gid: process.getgid!() },
      trustedUid: process.getuid!(),
      validate: async () => {},
      verify: async () => true,
      ...overrides,
    },
  });

  test("installs a validated, read-only rule for the invoking user and this binary", async () => {
    const validated: string[] = [];
    const validate = async (path: string) => void validated.push(await Bun.file(path).text());
    const result = await focusWith(asRoot({ validate }), "setup-sudo");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("brent can now run focus without sudo or a password");
    const rule = await Bun.file(join(dir, "sudoers-focus")).text();
    expect(rule).toContain(`\nbrent ALL=(root) NOPASSWD: ${binary}\n`);
    expect(validated).toEqual([rule]);
    expect((await stat(join(dir, "sudoers-focus"))).mode & 0o7777).toBe(0o440);
  });

  test("asks sudo to rerun it when not root", async () => {
    const calls: string[][] = [];
    const elevate = async (argv: string[]) => (calls.push(argv), 0);
    expect((await focusWith({ binaryPath: binary, elevate }, "setup-sudo")).code).toBe(0);
    expect(calls).toEqual([["setup-sudo"]]);
  });

  test("--dry-run shows the rule without root", async () => {
    const result = await focusWith({ binaryPath: binary, env: { USER: "brent" } }, "setup-sudo", "-n");
    expect(result.stdout).toContain(`brent ALL=(root) NOPASSWD: ${binary}`);
    expect(await Bun.file(join(dir, "sudoers-focus")).exists()).toBe(false);
  });

  test("leaves nothing behind when visudo rejects the rule", async () => {
    const validate = async () => {
      throw new Error("syntax error");
    };
    expect((await focusWith(asRoot({ validate }), "setup-sudo")).code).toBe(1);
    expect((await readdir(dir)).filter((name) => name.includes("sudoers"))).toEqual([]);
  });

  test("removes the rule again when sudo doesn't pick it up", async () => {
    const result = await focusWith(asRoot({ verify: async () => false }), "setup-sudo");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sudo didn't pick up");
    expect(await Bun.file(join(dir, "sudoers-focus")).exists()).toBe(false);
  });

  test("refuses a binary others could modify", async () => {
    await chmod(binary, 0o775);
    const result = await focusWith(asRoot(), "setup-sudo");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be owned by root and not writable by group or others");
    expect(await Bun.file(join(dir, "sudoers-focus")).exists()).toBe(false);
  });

  test("refuses to run from source", async () => {
    const result = await focusWith({ ...asRoot(), binaryPath: null }, "setup-sudo");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("only works with the installed focus binary");
  });

  test("refuses without a sudo user", async () => {
    const result = await focusWith({ ...asRoot(), env: { FOCUS_CONFIG: configFile } }, "setup-sudo");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("as your own user");
  });

  test("--remove deletes the rule", async () => {
    await focusWith(asRoot(), "setup-sudo");
    const removed = await focusWith(asRoot(), "setup-sudo", "--remove");
    expect(removed.stdout).toContain("Removed");
    expect(await Bun.file(join(dir, "sudoers-focus")).exists()).toBe(false);
    expect((await focusWith(asRoot(), "setup-sudo", "--remove")).stdout).toContain("No sudoers rule was installed");
  });

  test("--remove only works with setup-sudo", async () => {
    expect((await focus("off", "--remove")).code).toBe(2);
  });
});

describe("config file", () => {
  test("exact: true skips the www variant unless --no-exact is passed", async () => {
    await Bun.write(configFile, JSON.stringify({ exact: true }));
    await focus("add", "a.com");
    await focus("add", "--no-exact", "b.com");
    expect((await focus("status")).stdout).toContain("Sites (3):\n  a.com\n  b.com\n  www.b.com\n");
  });

  test("status shows the config path once the file exists", async () => {
    await Bun.write(configFile, "{}");
    expect((await focus("status")).stdout).toEndWith(`Config:     ${configFile}\n`);
  });

  test.each([
    ["{ exact: true }", /invalid JSON/],
    ["[]", /expected a JSON object/],
    ['{ "exact": "yes" }', /'exact' must be true or false/],
    ['{ "exat": true }', /unknown key 'exat'/],
  ])("rejects %p without touching the hosts file", async (content, message) => {
    await Bun.write(configFile, content);
    const result = await focus("add", "a.com");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain(configFile);
    expect(await read()).toBe(ORIGINAL);
  });

  test("help works even when the config is broken", async () => {
    await Bun.write(configFile, "nope");
    expect((await focus("--help")).code).toBe(0);
  });
});

describe("usage", () => {
  test("prints help", async () => {
    const result = await focus("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: focus");
  });

  test.each([[["frobnicate"]], [["add"]], [["on", "extra"]], [["status", "--bogus"]]])(
    "rejects %p",
    async (argv) => {
      expect((await focus(...argv)).code).toBe(2);
      expect(await read()).toBe(ORIGINAL);
    },
  );
});

test("runs as a standalone process", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "--hosts-file", hostsFile, "add", "a.com"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, NO_COLOR: "1", FOCUS_CONFIG: configFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toContain("Blocking:   on");
  expect(await read()).toContain("0.0.0.0 a.com");
});
