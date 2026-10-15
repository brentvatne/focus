import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
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
    expect(result.stderr).toContain("no sites are listed");
    expect(await read()).toBe(ORIGINAL);
  });

  test("status reports when nothing is set up", async () => {
    expect((await focus("status")).stdout).toBe(
      `Hosts file: ${hostsFile}\nBlocking:   off (no sites listed)\n` +
        `Config:     ${configFile} (not found; using defaults)\n`,
    );
  });
});

describe("--dry-run", () => {
  test("prints a diff and leaves the file and its metadata untouched", async () => {
    const before = await stat(hostsFile);
    const result = await focus("add", "--dry-run", "a.com");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`--- ${hostsFile}\n+++ ${hostsFile} (after focus add)\n@@ -4,3 +4,11 @@`);
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
    expect(result.stdout).toContain("-# state: on\n-0.0.0.0 a.com\n-:: a.com\n+# state: off\n+# 0.0.0.0 a.com\n+# :: a.com\n");
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
  const RECOMMENDED = ["x.com", "twitter.com", "facebook.com", "www.youtube.com", "youtu.be", "old.reddit.com"];

  test("--yes adds the recommended presets, but not Messenger", async () => {
    const result = await focus("init", "--yes");
    expect(result.code).toBe(0);
    const { stdout } = await focus("status");
    for (const host of RECOMMENDED) expect(stdout).toContain(`  ${host}\n`);
    expect(stdout).not.toContain("messenger.com");
    expect(stdout).not.toContain("instagram.com");
  });

  test("adds preset hosts exactly, ignoring the www expansion", async () => {
    await focus("init", "youtube");
    expect((await focus("status")).stdout).toContain(
      "Sites (4):\n  youtube.com\n  www.youtube.com\n  m.youtube.com\n  youtu.be\n",
    );
  });

  test("named presets skip the prompt", async () => {
    let prompted = false;
    const selectPresets = async () => ((prompted = true), []);
    expect((await focusWith({ selectPresets }, "init", "messenger", "Reddit")).code).toBe(0);
    expect(prompted).toBe(false);
    const { stdout } = await focus("status");
    expect(stdout).toContain("  www.messenger.com\n");
    expect(stdout).toContain("  redd.it\n");
    expect(stdout).not.toContain("facebook.com");
  });

  test("prompts with what's already listed and adds the chosen presets", async () => {
    await focus("add", "a.com");
    let seen: string[] = [];
    const selectPresets = async (_: unknown, listed: string[]) => ((seen = listed), ["hackernews"]);
    expect((await focusWith({ selectPresets }, "init")).code).toBe(0);
    expect(seen).toEqual(["a.com", "www.a.com"]);
    expect((await focus("status")).stdout).toContain("Sites (3):\n  a.com\n  www.a.com\n  news.ycombinator.com\n");
  });

  test("cancelling the prompt changes nothing", async () => {
    const result = await focusWith({ selectPresets: async () => null }, "init");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cancelled");
    expect(await read()).toBe(ORIGINAL);
  });

  test("selecting nothing changes nothing", async () => {
    const result = await focusWith({ selectPresets: async () => [] }, "init");
    expect(result.stdout).toContain("No changes");
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

  test("running it again is a no-op", async () => {
    await focus("init", "--yes");
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

describe("version and upgrade", () => {
  test.each([["--version"], ["-v"], ["version"]])("%s prints the version", async (arg) => {
    const result = await focus(arg);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${(await Bun.file(join(import.meta.dir, "../package.json")).json()).version}\n`);
  });

  test.each([
    [{ status: "up-to-date", current: "0.1.0" }, "focus 0.1.0 is up to date.\n"],
    [{ status: "available", current: "0.1.0", latest: "0.2.0" }, "focus 0.2.0 is available (you have 0.1.0)"],
    [{ status: "upgraded", current: "0.1.0", latest: "0.2.0", path: "/usr/local/bin/focus" }, "0.1.0 -> 0.2.0"],
  ] as const)("reports %o", async (outcome, message) => {
    const result = await focusWith({ upgrade: async () => outcome }, "upgrade");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(message);
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
