import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, type Key, run } from "../src/cli.ts";
import type { Mode, SiteRow, SitesChoice, SitesOptions } from "../src/prompt.ts";
import { encodeMessage, readMessage } from "../src/nativehost.ts";
import { UpgradeError, type UpgradeProgress } from "../src/upgrade.ts";
import { VERSION } from "../src/version.ts";

const ORIGINAL = `##
# Host Database
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost
`;
const EMPTY_SECTION = (state: "on" | "off") =>
  `# BEGIN focus\n# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.\n# state: ${state}\n# END focus\n`;

const EXTENSION_SOURCE = join(import.meta.dir, "..", "extension");

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

type Answer = (initial: Record<string, Mode>, rows: SiteRow[]) => SitesChoice | null;

/**
 * A stand-in for the per-site list: records each time it's shown, and answers with the next
 * of `answers` (repeating the last). Values are { rowId: "off" | "whole" | "partial" }.
 */
function sitesList(...answers: Answer[]) {
  const seen: { rows: SiteRow[]; initial: Record<string, Mode>; header?: string; focus?: string }[] = [];
  return {
    seen,
    chooseSites: async (rows: SiteRow[], initial: Record<string, Mode>, options: SitesOptions) => {
      seen.push({ rows: rows.map((row) => ({ ...row })), initial, header: options.header, focus: options.focus });
      return answers[Math.min(seen.length - 1, answers.length - 1)]!(initial, rows);
    },
  };
}
/** Answer with the initial values changed by `changes`. */
const set = (changes: Record<string, Mode>, add = false): Answer => (initial) => ({ values: { ...initial, ...changes }, add });

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
    stdoutIsTerminal: false,
    stderrIsTerminal: false,
    sleep: async () => {
      throw new Error("tests must stub sleep");
    },
    readKey: () => {
      throw new Error("tests must stub readKey");
    },
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
    // The allowlist and Chrome's folders live in the temp dir, never in the real ~/Library or ~/.config.
    chrome: {
      allowlistPath: join(dir, "subreddits.json"),
      feedsPath: join(dir, "feeds.json"),
      extensionSource: EXTENSION_SOURCE,
      extensionDir: join(dir, "chrome-extension"),
      nativeHostsDir: join(dir, "NativeMessagingHosts"),
      profilesDir: join(dir, "Chrome"),
      reveal: async () => {
        throw new Error("tests must stub chrome.reveal");
      },
      openInChrome: async () => {
        throw new Error("tests must stub chrome.openInChrome");
      },
      copyToClipboard: async () => {
        throw new Error("tests must stub chrome.copyToClipboard; it would change the real clipboard");
      },
    },
    statsPath: join(dir, "stats.jsonl"),
    now: () => Date.now(),
    nativeMessaging: {
      input: () => {
        throw new Error("tests must stub nativeMessaging.input");
      },
      output: async () => {
        throw new Error("tests must stub nativeMessaging.output");
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

  test("focus on its own toggles blocking", async () => {
    await focus("add", "a.com");
    const blocked = await read();

    expect((await focus()).code).toBe(0);
    expect((await focus("status")).stdout).toContain("Blocking:   off");
    expect((await focus()).code).toBe(0);
    expect(await read()).toBe(blocked);
  });

  test("focus on its own shows help when nothing is listed", async () => {
    const result = await focus();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: focus");
    expect(await read()).toBe(ORIGINAL);
  });

  test("focus on its own refuses --preset", async () => {
    await focus("add", "a.com");
    expect((await focus("--preset")).code).toBe(2);
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

  test("-n works for a bare toggle", async () => {
    await focus("add", "--exact", "a.com");
    const result = await focus("-n");
    expect(result.stdout).toContain(`+++ ${hostsFile} (after focus)\n`);
    expect(result.stdout).toContain("+# 0.0.0.0 a.com\n");
    expect((await focus("status")).stdout).toContain("Blocking:   on");
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
    const list = sitesList(() => null);
    expect((await focusWith({ chooseSites: list.chooseSites }, "init", "messenger", "Reddit")).code).toBe(0);
    expect(list.seen).toHaveLength(0);
    expect(await presetsLine()).toBe("Presets:    Reddit, Messenger");
    expect(await read()).not.toContain("facebook.com");
  });

  test("the list starts from the current presets, and turning one off removes it", async () => {
    await focus("init", "x", "youtube");
    await focus("add", "a.com");
    const list = sitesList(set({ x: "off", hackernews: "whole" }));
    expect((await focusWith({ chooseSites: list.chooseSites }, "init")).code).toBe(0);
    const { initial } = list.seen[0]!;
    expect(Object.entries(initial).filter(([, mode]) => mode !== "off")).toEqual([
      ["x", "whole"],
      ["youtube", "whole"],
      ["site:a.com", "whole"],
    ]);
    expect(await presetsLine()).toBe("Presets:    YouTube, Hacker News");
    expect(await read()).not.toContain("x.com");
    expect((await focus("status")).stdout).toContain("Sites (2):\n  a.com\n  www.a.com\n");
  });

  test("the list starts from the recommended presets on a fresh install", async () => {
    const list = sitesList(() => null);
    await focusWith({ chooseSites: list.chooseSites }, "init");
    const on = Object.entries(list.seen[0]!.initial).filter(([, mode]) => mode !== "off");
    expect(on.map(([id]) => id)).toEqual(["x", "facebook", "youtube", "reddit"]);
  });

  test("turning every preset off restores the original file", async () => {
    await focus("init", "--yes");
    const off = Object.fromEntries(["x", "facebook", "youtube", "reddit"].map((id) => [id, "off" as const]));
    expect((await focusWith({ chooseSites: sitesList(set(off)).chooseSites }, "init")).code).toBe(0);
    expect(await read()).toBe(ORIGINAL);
  });

  test("cancelling the list changes nothing", async () => {
    const result = await focusWith({ chooseSites: sitesList(() => null).chooseSites }, "init");
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
    expect(result.stderr).toContain("run `focus remove x`");
    expect(await read()).toBe(before);
  });

  test("a preset name works without --preset, mixed with hostnames", async () => {
    expect((await focus("add", "YouTube", "a.com")).code).toBe(0);
    expect((await focus("status")).stdout).toContain("Presets:    YouTube\nSites (2):\n  a.com\n  www.a.com\n");
    expect((await focus("add", "youtube")).stderr).toContain("the youtube preset is already on");
    expect((await focus("remove", "youtube", "a.com")).code).toBe(0);
    expect(await read()).toBe(ORIGINAL);
    expect((await focus("rm", "youtube")).stderr).toContain("the youtube preset isn't on");
  });

  test("a host covered by a preset added in the same command is reported, not listed twice", async () => {
    const result = await focus("add", "--exact", "youtube", "youtube.com");
    expect(result.stderr).toContain("youtube.com is already blocked by the YouTube preset");
    expect((await focus("status")).stdout).not.toContain("Sites");
  });

  test("removing a preset and one of its hosts together doesn't point back at the preset", async () => {
    await focus("init", "x");
    const result = await focus("remove", "x", "api.x.com");
    expect(result.stderr).toBe(`focus: api.x.com is not listed\n`);
    expect(await read()).toBe(ORIGINAL);
  });

  test("suggests the preset a typo was probably meant to be, and changes nothing", async () => {
    for (const [typo, suggestion] of [
      ["youtub", "youtube"],
      ["yuotube", "youtube"],
      ["twitter", "x"],
      ["hacker-news", "hackernews"],
      ["insta", "instagram"],
    ]) {
      const result = await focus("add", typo!, "a.com");
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`unknown preset '${typo}'; did you mean '${suggestion}'?`);
    }
    expect((await focus("remove", "redit")).stderr).toContain("did you mean 'reddit'?");
    expect((await focus("add", "--preset", "youtube.com")).stderr).toContain("did you mean 'youtube'?");
    expect((await focus("init", "messanger")).stderr).toContain("did you mean 'messenger'?");
    expect(await read()).toBe(ORIGINAL);
  });

  test("a word that's neither a preset nor close to one asks for a domain", async () => {
    const result = await focus("add", "foo");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("'foo' isn't a preset or a hostname; presets are x, facebook,");
    expect(result.stderr).toContain("hostnames need a domain, e.g. 'foo.com'");
  });

  test("other invalid arguments still get the hostname error", async () => {
    const result = await focus("add", "https://youtube.com/watch");
    expect(result.stderr).toContain("expected a hostname, not a URL. Did you mean 'youtube.com'?");
  });

  test("adding one of a preset's hostnames points to the preset", async () => {
    const result = await focus("add", "youtube.com");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      "focus: tip: `focus add youtube` blocks all of the YouTube preset, including m.youtube.com, youtu.be\n",
    );
    expect((await focus("status")).stdout).toContain("Sites (2):\n  youtube.com\n  www.youtube.com\n");
    expect((await focus("add", "youtube", "a.com")).stderr).toBe("");
  });

  test("--preset still treats every argument as a preset", async () => {
    expect((await focus("add", "--preset", "a.com")).stderr).toContain("unknown preset 'a.com'; choose from:");
    expect((await focus("add", "--preset")).stderr).toContain("add needs at least one preset name");
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

  test("updates the Chrome extension's files with the new binary, when it's set up", async () => {
    const calls: string[][] = [];
    const runBinary = async (_: string, args: string[]) => (calls.push(args), 0);
    await focusWith({ upgrade: upgraded, runBinary }, "upgrade");
    expect(calls).toEqual([["sync"]]);
    await mkdir(join(dir, "chrome-extension"));
    calls.length = 0;
    await focusWith({ upgrade: upgraded, runBinary }, "upgrade");
    expect(calls).toEqual([["sync"], ["chrome", "update"]]);
    calls.length = 0;
    // As root (sudo focus upgrade), the user's files are left alone.
    await focusWith({ upgrade: upgraded, runBinary, isRoot: true, systemHostsFile: hostsFile }, "upgrade");
    expect(calls).toEqual([["sync"]]);
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

  const reportingUpgrade = async (_: boolean, progress: (event: UpgradeProgress) => void) => {
    progress({ step: "checking" });
    for (const received of [0, 30_000_000, 60_000_000]) {
      progress({ step: "downloading", version: "0.2.0", received, total: 60_000_000 });
    }
    progress({ step: "verifying", version: "0.2.0" });
    progress({ step: "installing", version: "0.2.0", path: "/usr/local/bin/focus" });
    return upgraded();
  };

  test("shows one line per step on stderr when it isn't a terminal", async () => {
    const result = await focusWith({ upgrade: reportingUpgrade, runBinary: async () => 0 }, "upgrade");
    expect(result.stderr).toBe(
      "Checking for a new version…\n" +
        "Downloading focus 0.2.0… 0% of 60.0 MB\n" +
        "Verifying focus 0.2.0…\n" +
        "Installing focus 0.2.0 at /usr/local/bin/focus…\n",
    );
    expect(result.stdout).toBe("Upgraded focus 0.1.0 -> 0.2.0 (/usr/local/bin/focus).\n");
  });

  test("redraws a single status line in a terminal and erases it before the result", async () => {
    const result = await focusWith({ upgrade: reportingUpgrade, runBinary: async () => 0, stderrIsTerminal: true }, "upgrade");
    const redraw = "\r\x1b[K";
    expect(result.stderr).toBe(
      `${redraw}Checking for a new version…` +
        `${redraw}Downloading focus 0.2.0… 0% of 60.0 MB` +
        `${redraw}Downloading focus 0.2.0… 50% of 60.0 MB` +
        `${redraw}Downloading focus 0.2.0… 100% of 60.0 MB` +
        `${redraw}Verifying focus 0.2.0…` +
        `${redraw}Installing focus 0.2.0 at /usr/local/bin/focus…` +
        redraw,
    );
  });

  test("erases the status line when the upgrade fails", async () => {
    const upgrade = async (_: boolean, progress: (event: UpgradeProgress) => void) => {
      progress({ step: "checking" });
      throw new UpgradeError("GitHub API returned 500 for brentvatne/focus releases");
    };
    const result = await focusWith({ upgrade, stderrIsTerminal: true }, "upgrade");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("\r\x1b[KChecking for a new version…\r\x1b[Kfocus: GitHub API returned 500 for brentvatne/focus releases\n");
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

  test("asks sudo to toggle, but not when there's nothing to toggle", async () => {
    const calls: string[][] = [];
    const elevate = async (argv: string[]) => (calls.push(argv), 0);
    expect((await focusWith(asSystem({ elevate }))).stdout).toContain("Usage: focus");
    expect(calls).toEqual([]);

    await focusWith(asSystem({ isRoot: true }), "add", "a.com");
    expect((await focusWith(asSystem({ elevate }), "--no-flush")).code).toBe(0);
    expect(calls).toEqual([["--no-flush"]]);
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

describe("reddit", () => {
  const allowlist = () => join(dir, "subreddits.json");

  test("allow, list and disallow edit only the allowlist", async () => {
    await focus("add", "x.com");
    const hostsBefore = await read();

    const allowed = await focus("reddit", "allow", "Rust", "r/de", "https://old.reddit.com/r/rust/");
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe("Allowed in Chrome: r/rust, r/de\n");
    expect(await Bun.file(allowlist()).json()).toEqual({ version: 1, allow: ["rust", "de"] });

    expect((await focus("reddit", "allow", "rust")).stderr).toContain("r/rust is already allowed");
    expect((await focus("reddit", "list")).stdout).toBe("r/rust\nr/de\n");

    const removed = await focus("reddit", "disallow", "rust", "pics");
    expect(removed.stdout).toBe("No longer allowed: r/rust\n");
    expect(removed.stderr).toContain("r/pics isn't allowed");
    expect((await focus("reddit", "list")).stdout).toBe("r/de\n");

    expect(await read()).toBe(hostsBefore);
  });

  test("rejects options that don't apply instead of ignoring them", async () => {
    for (const flag of ["--exact", "--preset", "--yes"]) {
      const result = await focus("reddit", "allow", flag, "rust");
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`--${flag.replace(/^--(no-)?/, "")} doesn't apply to focus reddit`);
    }
    expect(await Bun.file(allowlist()).exists()).toBe(false);
  });

  test("list says when nothing is allowed", async () => {
    expect((await focus("reddit", "list")).stdout).toContain("No subreddits are allowed");
  });

  test("rejects bad names without writing anything", async () => {
    const result = await focus("reddit", "allow", "rust", "all", "a+b");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("r/all isn't a subreddit");
    expect(result.stderr).toContain("allow each one separately");
    expect(await Bun.file(allowlist()).exists()).toBe(false);
  });

  test("allow warns when the hosts file makes the list ineffective", async () => {
    const nothing = await focus("reddit", "allow", "rust");
    expect(nothing.stderr).toContain("focus isn't on yet; run `focus on` to start");
    expect(nothing.stderr).toContain("run `focus chrome install`");

    await focus("init", "reddit", "x");
    const dns = await focus("reddit", "allow", "de");
    expect(dns.stdout).toContain("The hosts file still blocks all of Reddit while focus is on, so this has no effect yet.");
    expect(dns.stdout).toContain("To stop that: focus remove reddit\n");
  });

  test.each([[["reddit"]], [["reddit", "frobnicate"]], [["reddit", "allow"]], [["reddit", "list", "x"]], [["reddit", "allow", "-n", "rust"]]])(
    "rejects %p",
    async (argv) => {
      expect((await focus(...argv)).code).toBe(2);
      expect(await Bun.file(allowlist()).exists()).toBe(false);
    },
  );

  test("refuses to run as root", async () => {
    const result = await focusWith({ isRoot: true, systemHostsFile: hostsFile }, "reddit", "allow", "rust");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("never needs root");
  });

  test("never asks sudo, even for the system hosts file", async () => {
    const result = await focusWith({ systemHostsFile: hostsFile, env: { FOCUS_CONFIG: configFile } }, "reddit", "allow", "rust");
    expect(result.code).toBe(0);
  });

  /** A stand-in for Chrome and the Mac: records what focus opens, and can play Chrome saving its profile. */
  function fakeChrome() {
    const opened: string[] = [];
    const revealed: string[] = [];
    const copied: string[] = [];
    const chrome = {
      allowlistPath: allowlist(),
      feedsPath: join(dir, "feeds.json"),
      extensionSource: EXTENSION_SOURCE,
      extensionDir: join(dir, "chrome-extension"),
      nativeHostsDir: join(dir, "NativeMessagingHosts"),
      profilesDir: join(dir, "Chrome"),
      reveal: async (path: string) => void revealed.push(path),
      openInChrome: async (url: string) => (opened.push(url), true),
      copyToClipboard: async (text: string) => (copied.push(text), true),
    };
    /** What Chrome writes when the extension is loaded in a profile. */
    const saveProfile = async (incognito: boolean, folder = "Default", name = "Person 1") => {
      await Bun.write(join(chrome.profilesDir, "Local State"), JSON.stringify({ profile: { info_cache: { [folder]: { name } } } }));
      const settings = { [ID]: { location: 4, path: chrome.extensionDir, incognito } };
      await Bun.write(join(chrome.profilesDir, folder, "Secure Preferences"), JSON.stringify({ extensions: { settings } }));
    };
    return { chrome, opened, revealed, copied, saveProfile };
  }

  const ID = "ppkaiojneebcgfinkmccagdflccineob";

  async function binary() {
    const path = join(dir, "focus-bin");
    await Bun.write(path, "");
    return path;
  }

  /**
   * A terminal session. Each readKey call takes the next key from `keys` (null: never pressed,
   * as while waiting), and each poll is one sleep, so `onSleep` can play Chrome by poll number.
   */
  function terminal(keys: (Key | null)[], onSleep: (call: number) => Promise<void> | void = () => {}) {
    let calls = 0;
    const queue = [...keys];
    return {
      stdoutIsTerminal: true,
      stderrIsTerminal: true,
      sleep: async () => void (await onSleep(++calls)),
      readKey: () => {
        const key = queue.shift() ?? null;
        return { key: key ? Promise.resolve(key) : new Promise<Key>(() => {}), stop: () => {} };
      },
      polls: () => calls,
    };
  }

  test("install writes the extension and registers the binary, and without a terminal opens nothing", async () => {
    const fake = fakeChrome();
    const path = await binary();
    const result = await focusWith({ binaryPath: path, chrome: fake.chrome }, "reddit", "install");
    expect(result.code).toBe(0);
    expect([fake.opened, fake.revealed, fake.copied]).toEqual([[], [], []]);
    expect(result.stdout).toContain(`✓ Wrote the extension to ${fake.chrome.extensionDir}\n✓ Registered focus with Chrome\n`);
    expect(result.stdout).toContain("1. Open chrome://extensions and turn on Developer mode, top right.");
    expect(result.stdout).toContain(`Load unpacked, press ⌘⇧G, paste this path and press Return:\n     ${fake.chrome.extensionDir}\n`);
    expect(result.stdout).not.toContain("Press Enter");
    expect(result.stdout).toContain("focus reddit allow <name...>  choose the subreddits to keep");
    expect(result.stdout).toContain("focus status                  check that Chrome has loaded it");
    expect(result.stdout).not.toContain("\x1b");
    expect(await Bun.file(join(fake.chrome.extensionDir, "manifest.json")).json()).toMatchObject({ version_name: VERSION });
    expect(await Bun.file(join(fake.chrome.nativeHostsDir, "com.brentvatne.focus.json")).json()).toEqual({
      name: "com.brentvatne.focus",
      description: expect.any(String),
      path: await realpath(path),
      type: "stdio",
      allowed_origins: [`chrome-extension://${ID}/`],
    });
  });

  test("in a terminal, install asks before opening anything, then waits for each step", async () => {
    const fake = fakeChrome();
    const session = terminal(["enter", null, "enter", null], async (call) => {
      if (call === 3) await fake.saveProfile(false);
      if (call === 5) await fake.saveProfile(true);
    });
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome, ...session }, "reddit", "install");
    expect(result.code).toBe(0);
    expect(fake.opened).toEqual(["chrome://extensions/", `chrome://extensions/?id=${ID}`]);
    expect(fake.revealed).toEqual([fake.chrome.extensionDir]);
    expect(fake.copied).toEqual([fake.chrome.extensionDir]);
    expect(result.stdout).toContain(
      "\nPress Enter to open chrome://extensions, show the folder in Finder and copy its path (Esc skips) \n",
    );
    expect(result.stdout).toContain("✓ Chrome loaded it (profile Person 1)\n");
    expect(result.stdout).toContain("\nPress Enter to open its details page (Esc skips) \n");
    expect(result.stdout).toContain("✓ Allowed in Incognito\n");
    expect(result.stdout).not.toContain("focus status");
    expect(result.stderr).toContain("⠙ Waiting for Chrome to load it…");
    expect(result.stderr).toContain("Waiting for Incognito access…");
    expect(result.stderr).toEndWith("\r\x1b[K");
  });

  test("Esc skips a step without opening anything or waiting", async () => {
    const fake = fakeChrome();
    const session = terminal(["skip"]);
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome, ...session }, "reddit", "install");
    expect(result.code).toBe(0);
    expect([fake.opened, fake.revealed, fake.copied]).toEqual([[], [], []]);
    expect(result.stdout).toContain("(Esc skips) skipped\n");
    expect(result.stdout).toContain("check that Chrome has loaded it");
    expect(session.polls()).toBe(0);
  });

  test("Enter stops waiting, and the remaining steps still print", async () => {
    const fake = fakeChrome();
    const session = terminal(["enter", "enter"]);
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome, ...session }, "reddit", "install");
    expect(result.code).toBe(0);
    expect(fake.opened).toEqual(["chrome://extensions/"]);
    expect(result.stdout).not.toContain("✓ Chrome loaded it");
    expect(result.stdout).toContain("check that Chrome has loaded it");
  });

  test("Ctrl-C at a prompt stops install with nothing opened", async () => {
    const fake = fakeChrome();
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome, ...terminal(["interrupt"]) }, "reddit", "install");
    expect(result.code).toBe(130);
    expect(fake.opened).toEqual([]);
    expect(result.stdout).not.toContain("skipped");
    expect(result.stdout).not.toContain("Then");
  });

  test("says so when Chrome can't be opened or the path can't be copied", async () => {
    const fake = fakeChrome();
    const chrome = { ...fake.chrome, openInChrome: async () => false, copyToClipboard: async () => false };
    const result = await focusWith({ binaryPath: await binary(), chrome, ...terminal(["enter", "enter"]) }, "reddit", "install");
    expect(result.stdout).toContain("Chrome didn't open; open chrome://extensions in Google Chrome yourself.");
    expect(result.stdout).toContain(`Couldn't copy the path; it's ${fake.chrome.extensionDir}`);
  });

  test("install skips the Chrome steps when Chrome already has it", async () => {
    const fake = fakeChrome();
    await fake.saveProfile(true, "Profile 2", "Work");
    await Bun.write(allowlist(), '{"version":1,"allow":["rust"]}');
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome, ...terminal([]) }, "reddit", "install");
    expect(result.stdout).toContain("✓ Chrome already has it loaded (profile Work)\n");
    expect(result.stdout).not.toContain("Load it in Chrome");
    expect(result.stdout).not.toContain("Incognito");
    expect(result.stdout).not.toContain("Then");
    expect(fake.opened).toEqual([]);
  });

  test("without a terminal, the Incognito step names the details page", async () => {
    const fake = fakeChrome();
    await fake.saveProfile(false);
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "reddit", "install");
    expect(result.stdout).toContain(`Turn on Allow in Incognito on the extension's details page, chrome://extensions/?id=${ID}.`);
    expect(fake.opened).toEqual([]);
  });

  test("install links the folder and the guide in terminals that support links", async () => {
    const fake = fakeChrome();
    const env = { FOCUS_HOSTS_FILE: hostsFile, FOCUS_CONFIG: configFile, TERM_PROGRAM: "iTerm.app" };
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome, env, ...terminal(["skip"]) }, "reddit", "install");
    expect(result.stdout).toContain(`\x1b]8;;file://${fake.chrome.extensionDir}\x1b\\${fake.chrome.extensionDir}\x1b]8;;\x1b\\`);
    expect(result.stdout).toContain("\x1b]8;;https://github.com/brentvatne/focus/blob/main/docs/guide.md#finer-blocking-in-chrome\x1b\\the guide");
  });

  test("status and allow report whether Chrome has loaded the extension", async () => {
    const fake = fakeChrome();
    await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "reddit", "install");
    await focus("add", "a.com");
    const notLoaded = await focusWith({ chrome: fake.chrome }, "reddit", "allow", "rust");
    expect(notLoaded.stderr).toContain("Chrome hasn't loaded the extension yet");
    expect((await focusWith({ chrome: fake.chrome }, "status")).stdout).toContain(
      "Extension:  not loaded in Chrome; run `focus chrome install` to finish\n",
    );
    await fake.saveProfile(false);
    expect((await focusWith({ chrome: fake.chrome }, "status")).stdout).toContain(
      "Extension:  loaded in Chrome (profile Person 1), not allowed in Incognito\n",
    );
    expect((await focusWith({ chrome: fake.chrome }, "reddit", "allow", "de")).stderr).toBe("");
  });

  test("a profile with the extension loaded from another folder doesn't count", async () => {
    const fake = fakeChrome();
    await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "reddit", "install");
    await fake.saveProfile(true);
    const prefs = join(fake.chrome.profilesDir, "Default", "Secure Preferences");
    await Bun.write(prefs, (await Bun.file(prefs).text()).replace(fake.chrome.extensionDir, "/somewhere/else"));
    expect((await focusWith({ chrome: fake.chrome }, "status")).stdout).toContain("Extension:  not loaded in Chrome");
  });

  test("uninstall removes the files, then offers to open Chrome's page to remove it there", async () => {
    const fake = fakeChrome();
    await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "reddit", "install");
    await fake.saveProfile(true);
    const plain = await focusWith({ chrome: fake.chrome }, "reddit", "uninstall");
    expect(plain.stdout).toContain(`Removed ${fake.chrome.extensionDir}`);
    expect(plain.stdout).toContain(
      `Chrome still lists the focus extension (profile Person 1); click Remove on its details page, chrome://extensions/?id=${ID}.`,
    );
    expect(fake.opened).toEqual([]);
    expect(await readdir(dir)).not.toContain("chrome-extension");
    expect(await readdir(fake.chrome.nativeHostsDir)).toEqual([]);

    // Chrome keeps listing it until it's removed there; in a terminal, uninstall offers to open the page.
    await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "reddit", "install");
    const asked = await focusWith({ chrome: fake.chrome, ...terminal(["enter"]) }, "reddit", "uninstall");
    expect(asked.stdout).toContain("Press Enter to open it (Esc skips) \n");
    expect(fake.opened).toEqual([`chrome://extensions/?id=${ID}`]);
    expect((await focusWith({ chrome: fake.chrome }, "reddit", "uninstall")).stdout).toContain("Nothing to remove");
  });

  const feedsFile = () => join(dir, "feeds.json");
  const presetsLineOf = async () => (await focus("status")).stdout.split("\n").find((line) => line.startsWith("Presets:"));

  test("feeds add, list and remove edit only the feeds file", async () => {
    const before = await read();
    const added = await focus("feeds", "add", "YouTube", "x");
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("✓ YouTube: feed only, in Chrome (videos still work)\n");
    expect(added.stdout).toContain("✓ X: feed only, in Chrome (posts and profiles still work)\n");
    expect(await Bun.file(feedsFile()).json()).toEqual({ version: 1, feeds: ["youtube", "x"] });
    expect((await focus("feeds", "add", "x")).stderr).toContain("X's feed is already blocked");
    expect((await focus("feeds", "list")).stdout).toBe(
      "youtube: the home page, Shorts and Explore, and recommendations on video pages\nx: the Home timeline, Explore, search and notifications\n",
    );
    const removed = await focus("feeds", "remove", "youtube");
    expect(removed.stdout).toBe("No longer blocking the feed of YouTube\nTo block all of it again: focus add youtube\n");
    expect((await focus("feeds", "remove", "youtube")).stderr).toContain("YouTube's feed isn't blocked");
    expect(await Bun.file(feedsFile()).json()).toEqual({ version: 1, feeds: ["x"] });
    expect(await read()).toBe(before);
  });

  test("with only Chrome settings, focus on, off and the toggle work through an empty section", async () => {
    await focus("feeds", "add", "youtube");
    expect((await focus()).stdout).not.toContain("Usage:"); // the bare toggle turns it on
    expect(await read()).toBe(ORIGINAL + EMPTY_SECTION("on"));
    expect((await focus("status")).stdout).toContain("Blocking:   on (in Chrome only; nothing in the hosts file)\n");
    await focus("off");
    expect(await read()).toBe(ORIGINAL + EMPTY_SECTION("off"));
    await focus("on");
    expect(await read()).toBe(ORIGINAL + EMPTY_SECTION("on"));
  });

  test("without Chrome settings, removing the last site still restores the file exactly", async () => {
    await focus("add", "a.com");
    await focus("remove", "a.com");
    expect(await read()).toBe(ORIGINAL);
    expect((await focus("on")).stderr).toContain("nothing is listed yet");
  });

  test("through sudo, the Chrome settings are passed as --keep-empty, since root can't read them", async () => {
    await focus("feeds", "add", "x");
    const calls: string[][] = [];
    await focusWith({ systemHostsFile: hostsFile, env: { FOCUS_CONFIG: configFile }, elevate: async (argv) => (calls.push(argv), 0) }, "on");
    expect(calls).toEqual([["on", "--keep-empty"]]);
    // As root, the flag is all it has to go on.
    const root = await focusWith({ isRoot: true, systemHostsFile: hostsFile, env: { FOCUS_CONFIG: configFile } }, "on", "--keep-empty");
    expect(root.code).toBe(0);
    expect(await read()).toBe(ORIGINAL + EMPTY_SECTION("on"));
  });

  test("feeds list says when nothing is blocked", async () => {
    expect((await focus("feeds", "list")).stdout).toBe("No feeds are blocked. Add one with `focus feeds add youtube x instagram`.\n");
  });

  test.each([
    ["twitter", "did you mean 'x'?"],
    ["youtub", "did you mean 'youtube'?"],
    ["facebook", "it can for youtube, x"],
  ])("feeds add %s is refused with a suggestion", async (name, message) => {
    const result = await focus("feeds", "add", name);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`'${name}' isn't a site whose feed focus can block; ${message}`);
    expect(await Bun.file(feedsFile()).exists()).toBe(false);
  });

  test.each([[["feeds"]], [["feeds", "add"]], [["feeds", "frobnicate"]], [["feeds", "list", "x"]], [["feeds", "add", "-n", "x"]], [["chrome"]], [["chrome", "install", "x"]]])(
    "rejects %p",
    async (argv) => {
      expect((await focus(...argv)).code).toBe(2);
      expect(await Bun.file(feedsFile()).exists()).toBe(false);
    },
  );

  test("feeds refuses root", async () => {
    const result = await focusWith({ isRoot: true, systemHostsFile: hostsFile }, "feeds", "add", "x");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("run `focus feeds` as yourself");
  });

  test("feeds add says when the hosts file blocks the whole site, and how to stop that", async () => {
    await focus("init", "youtube", "x");
    const result = await focus("feeds", "add", "youtube");
    expect(result.stdout).toContain("The hosts file still blocks all of YouTube while focus is on, so this has no effect yet.\nTo stop that: focus remove youtube\n");
    expect((await focus("status")).stdout).toContain(
      "In Chrome:  YouTube feed only\n            (no effect for YouTube: the hosts file blocks the whole site)\n",
    );
  });

  test("in a terminal, Enter turns off the preset that blocks the whole site", async () => {
    const fake = fakeChrome();
    await focus("init", "youtube", "x");
    const result = await focusWith({ chrome: fake.chrome, ...terminal(["enter"]) }, "feeds", "add", "youtube", "x");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Press Enter to stop that (runs `focus remove x youtube`) (Esc skips) \n");
    // No hosts left, but the Chrome settings keep the section for the on/off state.
    expect(await read()).toBe(ORIGINAL + EMPTY_SECTION("on"));
    expect((await focusWith({ chrome: fake.chrome }, "status")).stdout).toContain("In Chrome:  YouTube feed only, X feed only\n");
  });

  test("Esc keeps the preset", async () => {
    await focus("init", "youtube");
    const before = await read();
    const result = await focusWith({ ...terminal(["skip"]) }, "feeds", "add", "youtube");
    expect(result.code).toBe(0);
    expect(await read()).toBe(before);
  });

  test("reddit allow offers to turn off the reddit preset too", async () => {
    await focus("init", "reddit", "x");
    const result = await focusWith({ ...terminal(["enter"]) }, "reddit", "allow", "rust");
    expect(result.stdout).toContain("runs `focus remove reddit`");
    expect((await focus("status")).stdout).toContain("Presets:    X / Twitter\n");
  });

  test("chrome install suggests feeds and subreddits when neither is set up", async () => {
    const fake = fakeChrome();
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "install");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("focus feeds add youtube x instagram  block just their feeds\n");
    expect(result.stdout).toContain("focus reddit allow <name...>         limit Reddit to chosen subreddits\n");
  });

  test("chrome install points out presets that undo what Chrome is set to do", async () => {
    const fake = fakeChrome();
    await focus("init", "youtube", "reddit", "x");
    await focus("feeds", "add", "youtube");
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "install");
    expect(result.stdout).toContain("focus remove youtube  stop the hosts file from blocking all of YouTube\n");
    expect(result.stdout).not.toContain("focus reddit allow");
  });

  /** Installs the extension, then makes its folder look like an older version's. */
  async function oldExtension(fake: ReturnType<typeof fakeChrome>, version = "0.1.3") {
    await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "install");
    const manifest = join(fake.chrome.extensionDir, "manifest.json");
    await Bun.write(manifest, JSON.stringify({ ...(await Bun.file(manifest).json()), version_name: version }));
    await Bun.write(join(fake.chrome.extensionDir, "background.js"), "// old");
  }

  test("chrome update brings an older extension's files up to this version", async () => {
    const fake = fakeChrome();
    await oldExtension(fake);
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "update");
    expect(result.code).toBe(0);
    // Chrome hasn't loaded it here, so restarting wouldn't help.
    expect(result.stdout).toBe(`Updated the Chrome extension's files from 0.1.3 to ${VERSION}. Chrome hasn't loaded it yet; run \`focus chrome install\`.\n`);
    expect(await Bun.file(join(fake.chrome.extensionDir, "manifest.json")).json()).toMatchObject({ version_name: VERSION });
    expect(await Bun.file(join(fake.chrome.extensionDir, "background.js")).text()).not.toBe("// old");
    const again = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "update");
    expect(again.stdout).toBe(`The Chrome extension's files are up to date (${VERSION}).\n`);
  });

  test("after updating the files of a loaded extension, chrome update says to restart Chrome", async () => {
    const fake = fakeChrome();
    await oldExtension(fake);
    await fake.saveProfile(true);
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "update");
    expect(result.stdout).toBe(
      `Updated the Chrome extension's files from 0.1.3 to ${VERSION}. Restart Chrome to use the new version (or click ↻ on focus at chrome://extensions).\n`,
    );
  });

  test("chrome update says when there's nothing installed", async () => {
    const result = await focusWith({ binaryPath: await binary(), chrome: fakeChrome().chrome }, "chrome", "update");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("isn't set up; run `focus chrome install`");
  });

  test("feeds and reddit commands update an older extension's files first", async () => {
    const fake = fakeChrome();
    await oldExtension(fake);
    const result = await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "feeds", "list");
    expect(result.stdout).toStartWith(`Updated the Chrome extension's files from 0.1.3 to ${VERSION}.`);
    expect((await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "reddit", "list")).stdout).not.toContain("Updated");
  });

  test("running from source never rewrites the extension's files", async () => {
    const fake = fakeChrome();
    await oldExtension(fake);
    await focusWith({ binaryPath: null, chrome: fake.chrome }, "feeds", "list");
    expect(await Bun.file(join(fake.chrome.extensionDir, "manifest.json")).json()).toMatchObject({ version_name: "0.1.3" });
  });

  test("status says when it can't see Chrome's profiles, instead of calling it not loaded", async () => {
    const fake = fakeChrome();
    await focusWith({ binaryPath: await binary(), chrome: fake.chrome }, "chrome", "install");
    await mkdir(fake.chrome.profilesDir, { recursive: true });
    await chmod(fake.chrome.profilesDir, 0o000);
    try {
      expect((await focusWith({ chrome: fake.chrome }, "status")).stdout).toContain(
        "Extension:  set up; couldn't check whether Chrome has it loaded (no access to Chrome's profile files)\n",
      );
      await focus("add", "a.com");
      expect((await focusWith({ chrome: fake.chrome }, "reddit", "allow", "rust")).stderr).not.toContain("hasn't loaded");
    } finally {
      await chmod(fake.chrome.profilesDir, 0o755);
    }
  });

  test("config shows one row per site, with its Chrome option where it has one, starting from what's set", async () => {
    await focus("init", "youtube", "x");
    await focus("add", "example.com");
    await focus("feeds", "add", "instagram");
    await focus("reddit", "allow", "rust");
    const list = sitesList(() => null);
    await focusWith({ chooseSites: list.chooseSites }, "config");
    const { rows, initial, header } = list.seen[0]!;
    expect(header).toBe("focus is on");
    expect(rows.map((row) => `${row.name}: ${row.modes.map((option) => option.label).join(" / ")}`)).toEqual([
      "X / Twitter: off / whole site / feed only",
      "Facebook: off / whole site",
      "YouTube: off / whole site / feed only",
      "Reddit: off / whole site / chosen subreddits",
      "Instagram: off / whole site / messages only",
      "TikTok: off / whole site",
      "LinkedIn: off / whole site",
      "Hacker News: off / whole site",
      "Messenger: off / whole site",
      "example.com: off / blocked",
    ]);
    expect(Object.entries(initial).filter(([, mode]) => mode !== "off")).toEqual([
      ["x", "whole"],
      ["youtube", "whole"],
      ["reddit", "partial"],
      ["instagram", "partial"],
      ["site:example.com", "whole"],
    ]);
    expect(rows.find((row) => row.id === "reddit")!.modes[2]!.detail).toBe("Only r/rust load, in Chrome.");
  });

  test("config switches YouTube from the whole site to feed only", async () => {
    await focus("init", "youtube", "x");
    const result = await focusWith({ chooseSites: sitesList(set({ youtube: "partial" })).chooseSites }, "config");
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("✓ YouTube: feed only (in Chrome)\n");
    expect(await Bun.file(feedsFile()).json()).toEqual({ version: 1, feeds: ["youtube"] });
    expect(await presetsLineOf()).toBe("Presets:    X / Twitter");
    expect(result.stdout).toContain("Set it up with: focus chrome install");
    // One summary, not the status block and backup path of each hosts change.
    expect(result.stdout).not.toContain("Hosts file:");
    expect(result.stdout).not.toContain("Previous version saved");
  });

  test("if the hosts change fails, the Chrome settings aren't changed either", async () => {
    await focus("init", "youtube", "x");
    await chmod(dir, 0o555); // the hosts file can't be replaced, as when sudo is cancelled
    try {
      const result = await focusWith({ chooseSites: sitesList(set({ youtube: "partial" })).chooseSites }, "config");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("the hosts file wasn't changed, so nothing else was either");
      expect(result.stdout).not.toContain("✓");
    } finally {
      await chmod(dir, 0o755);
    }
    expect(await Bun.file(feedsFile()).exists()).toBe(false);
    expect(await presetsLineOf()).toBe("Presets:    X / Twitter, YouTube");
  });

  test("config with only Chrome settings keeps the section, so focus on and off work", async () => {
    const result = await focusWith({ chooseSites: sitesList(set({ youtube: "partial" })).chooseSites }, "config");
    expect(result.code).toBe(0);
    expect(await read()).toBe(ORIGINAL + EMPTY_SECTION("on"));
    // And turning the last Chrome option off restores the file exactly.
    await focusWith({ chooseSites: sitesList(set({ youtube: "off" })).chooseSites }, "config");
    expect(await read()).toBe(ORIGINAL);
    expect(await Bun.file(feedsFile()).json()).toEqual({ version: 1, feeds: [] });
  });

  test("config asks for subreddits before changing anything, and keeps them when Reddit is turned off", async () => {
    await focus("add", "a.com");
    let asked = "";
    const askText = async (message: string) => ((asked = message), "rust r/AskHistorians");
    const on = await focusWith({ chooseSites: sitesList(set({ reddit: "partial" })).chooseSites, askText }, "config");
    expect(asked).toContain("Which subreddits");
    expect(on.stdout).toContain("✓ Reddit: chosen subreddits (in Chrome)\n");
    expect(await Bun.file(allowlist()).json()).toEqual({ version: 1, allow: ["rust", "askhistorians"] });
    await focusWith({ chooseSites: sitesList(set({ reddit: "off" })).chooseSites }, "config");
    expect(await Bun.file(allowlist()).json()).toEqual({ version: 1, enabled: false, allow: ["rust", "askhistorians"] });
    expect((await focus("status")).stdout).toContain("Subreddits: r/rust, r/askhistorians (off; turn it on with `focus config`)\n");
    // Back on: the list is still there, so nothing to ask.
    asked = "";
    await focusWith({ chooseSites: sitesList(set({ reddit: "partial" })).chooseSites, askText }, "config");
    expect(asked).toBe("");
    expect(await Bun.file(allowlist()).json()).toEqual({ version: 1, allow: ["rust", "askhistorians"] });
  });

  test("cancelling the subreddit question changes nothing", async () => {
    await focus("init", "reddit");
    const result = await focusWith({ chooseSites: sitesList(set({ reddit: "partial" })).chooseSites, askText: async () => null }, "config");
    expect(result.stdout).toBe("Cancelled; nothing was changed.\n");
    expect(await presetsLineOf()).toBe("Presets:    Reddit");
    expect(await Bun.file(allowlist()).exists()).toBe(false);
  });

  test("a site set both whole and in Chrome shows as whole, and leaving it alone keeps both", async () => {
    await focus("init", "youtube");
    await focus("feeds", "add", "youtube");
    const list = sitesList(set({ x: "whole" }));
    await focusWith({ chooseSites: list.chooseSites }, "config");
    const youtube = list.seen[0]!.rows.find((row) => row.id === "youtube")!;
    expect(list.seen[0]!.initial.youtube).toBe("whole");
    expect(youtube.note).toBe("Its Chrome option is set too; the whole site wins.");
    expect(await Bun.file(feedsFile()).json()).toEqual({ version: 1, feeds: ["youtube"] });
  });

  test("config adds and removes your own sites", async () => {
    await focus("add", "old.example");
    const askText = async () => "https://news.example.org/path";
    const askHost = async () => "news.example.org";
    let calls = 0;
    const list = sitesList(set({}, true), set({ "site:old.example": "off" }));
    const result = await focusWith(
      { chooseSites: list.chooseSites, askText: async (...args: [string, string]) => (++calls === 1 ? askText() : askHost()) },
      "config",
    );
    // A URL isn't a hostname: it says so and goes back to the list, which asks again.
    expect(result.stdout).toContain("expected a hostname, not a URL");
    expect(list.seen[1]!.focus).toBe("\0add");
    expect(result.code).toBe(0);
    expect((await focus("status")).stdout).not.toContain("old.example");
    expect(list.seen.length).toBeGreaterThanOrEqual(2);
  });

  test("adding a preset's hostname points to its row instead", async () => {
    const list = sitesList(set({}, true), () => null);
    const result = await focusWith({ chooseSites: list.chooseSites, askText: async () => "youtube.com" }, "config");
    expect(result.stdout).toContain("youtube.com is part of YouTube; set it on that row.");
    expect(list.seen[1]!.focus).toBe("youtube");
  });

  test("an added site gets its own row, already blocked", async () => {
    const list = sitesList(set({}, true), (initial) => ({ values: initial, add: false }));
    await focusWith({ chooseSites: list.chooseSites, askText: async () => "news.example.org" }, "config");
    expect(list.seen[1]!.rows.at(-1)!.name).toBe("news.example.org");
    expect(list.seen[1]!.initial["site:news.example.org"]).toBe("whole");
    expect((await focus("status")).stdout).toContain("news.example.org");
  });

  test("config with nothing changed says so", async () => {
    await focus("init", "x");
    const result = await focusWith({ chooseSites: sitesList((initial) => ({ values: initial, add: false })).chooseSites }, "config");
    expect(result.stdout).toBe("No changes.\n");
  });

  test("config --dry-run shows the hosts diff and saves nothing", async () => {
    const result = await focusWith({ chooseSites: sitesList(set({ x: "whole", youtube: "partial" })).chooseSites }, "config", "--dry-run");
    expect(result.stdout).toContain("✓ YouTube: feed only (in Chrome) (dry run: not saved)");
    expect(result.stdout).toContain("+0.0.0.0 x.com");
    expect(await Bun.file(feedsFile()).exists()).toBe(false);
    expect(await read()).toBe(ORIGINAL);
  });

  test("config needs a terminal", async () => {
    const result = await focus("config");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("config needs an interactive terminal");
  });

  test("as root, config offers only off and whole", async () => {
    const list = sitesList(set({ x: "whole" }));
    await focusWith({ chooseSites: list.chooseSites, isRoot: true, systemHostsFile: hostsFile }, "config");
    expect(list.seen[0]!.rows.every((row) => row.modes.length === 2)).toBe(true);
    expect(await presetsLineOf()).toBe("Presets:    X / Twitter");
    expect(await Bun.file(feedsFile()).exists()).toBe(false);
  });

  test("init welcomes you, starts from the recommended presets, and ends with what's next", async () => {
    const list = sitesList((initial) => ({ values: initial, add: false }));
    const result = await focusWith({ chooseSites: list.chooseSites }, "init");
    expect(result.stdout).toStartWith("focus blocks distracting sites while it's on.");
    expect(result.stdout).toContain("✓ X / Twitter: whole site\n");
    expect(result.stdout).toContain("focus config      change what's blocked");
  });

  test("in a terminal, config offers to set up the extension the Chrome options need", async () => {
    const fake = fakeChrome();
    const result = await focusWith(
      { chooseSites: sitesList(set({ x: "partial" })).chooseSites, binaryPath: await binary(), chrome: fake.chrome, ...terminal(["enter", "skip"]) },
      "config",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("The Chrome options need the focus extension, which Chrome hasn't loaded yet.");
    expect(result.stdout).toContain("✓ Registered focus with Chrome");
  });

  test("install refuses to run from source", async () => {
    const result = await focus("reddit", "install");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not when running from source");
    expect(await readdir(dir)).not.toContain("NativeMessagingHosts");
  });

  test("status shows the list only once there is one", async () => {
    await focus("add", "x.com");
    expect((await focus("status")).stdout).not.toContain("Subreddits");
    await focus("reddit", "allow", "rust");
    expect((await focus("status")).stdout).toContain("Subreddits: r/rust (allowed in Chrome)\nConfig:");
    await focus("add", "--preset", "reddit");
    expect((await focus("status")).stdout).toContain("(no effect: the hosts file blocks all of Reddit)");
  });

  test("status as root doesn't read the allowlist", async () => {
    await focus("add", "x.com");
    await Bun.write(allowlist(), "not json");
    expect((await focus("status")).stdout).toContain("Subreddits: ");
    const asRoot = await focusWith({ isRoot: true, systemHostsFile: hostsFile, env: { FOCUS_CONFIG: configFile } }, "status");
    expect(asRoot.code).toBe(0);
    expect(asRoot.stdout).not.toContain("Subreddits");
  });
});

describe("stats", () => {
  const statsFile = () => join(dir, "stats.jsonl");
  const events = async () => (await Bun.file(statsFile()).exists() ? (await Bun.file(statsFile()).text()).trim().split("\n").map((line) => JSON.parse(line)) : []);
  /** As you, on the real hosts file: sudo is a stand-in that runs the same command as root. */
  const asYou = (now: number, ...argv: string[]) =>
    focusWith(
      {
        systemHostsFile: hostsFile,
        now: () => now,
        elevate: async (args) => (await focusWith({ isRoot: true, systemHostsFile: hostsFile, env: { FOCUS_CONFIG: configFile } }, ...args)).code,
      },
      ...argv,
    );

  test("records each time blocking is turned on or off, by the process that asked sudo for it", async () => {
    await asYou(Date.parse("2026-10-16T09:00:00Z"), "add", "a.com");
    await asYou(Date.parse("2026-10-16T10:00:00Z"), "off");
    await asYou(Date.parse("2026-10-16T10:05:00Z"), "status");
    await asYou(Date.parse("2026-10-16T10:30:00Z"));
    expect(await events()).toEqual([
      { at: "2026-10-16T09:00:00.000Z", event: "on" },
      { at: "2026-10-16T10:00:00.000Z", event: "off" },
      { at: "2026-10-16T10:30:00.000Z", event: "on" },
    ]);
  });

  test("a change made elsewhere is recorded as noticed when focus next runs", async () => {
    await asYou(Date.parse("2026-10-16T09:00:00Z"), "add", "a.com");
    // As if `sudo focus off` ran: root never writes stats.
    await focusWith({ isRoot: true, systemHostsFile: hostsFile, env: { FOCUS_CONFIG: configFile } }, "off");
    expect(await events()).toHaveLength(1);
    await asYou(Date.parse("2026-10-16T11:00:00Z"), "status");
    expect((await events())[1]).toEqual({ at: "2026-10-16T11:00:00.000Z", event: "off", seen: true });
  });

  test("other hosts files, dry runs and failed changes aren't recorded", async () => {
    await focus("add", "a.com");
    expect(await events()).toEqual([]);
    await asYou(Date.parse("2026-10-16T09:00:00Z"), "add", "b.com", "--dry-run");
    const failed = await focusWith({ systemHostsFile: hostsFile, elevate: async () => 1 }, "off");
    expect(failed.code).toBe(1);
    // Only the first note that focus is on, which it already was.
    expect(await events()).toEqual([{ at: "2026-10-16T09:00:00.000Z", event: "on", seen: true }]);
  });

  test("focus stats shows the days, and --days changes how many", async () => {
    await asYou(Date.parse("2026-10-16T09:00:00Z"), "add", "a.com");
    const result = await focusWith({ now: () => Date.parse("2026-10-16T10:00:00Z") }, "stats", "--days", "2");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("focus is on, for 1h 00m");
    expect(result.stdout.split("\n").filter((line) => /^(Today|Yesterday|Total) /.test(line))).toHaveLength(3);
    expect(result.stdout).toContain("`focus chrome install`");
    expect((await focus("stats", "--days", "0")).code).toBe(2);
    expect((await focus("status", "--days", "3")).stderr).toContain("--days only works with stats");
    expect((await focusWith({ isRoot: true, systemHostsFile: hostsFile }, "stats")).stderr).toContain("as yourself");
  });
});

describe("native messaging host", () => {
  async function host(request: unknown, overrides: Partial<Io> = {}) {
    let reply: Uint8Array | null = null;
    const result = await focusWith(
      {
        // Chrome runs the host as the user, against the real system hosts file; here, the temp one.
        systemHostsFile: hostsFile,
        nativeMessaging: {
          input: async function* () {
            yield encodeMessage(request);
          },
          output: async (bytes) => void (reply = bytes),
        },
        elevate: async () => {
          throw new Error("the native host must never elevate");
        },
        ...overrides,
      },
      "chrome-extension://ppkaiojneebcgfinkmccagdflccineob/",
    );
    return { ...result, reply: reply ? await readMessage((async function* () { yield reply!; })()) : null };
  }

  test("answers with the state and the allowlist, and changes nothing", async () => {
    await focus("add", "x.com");
    await focus("reddit", "allow", "rust");
    const before = await read();
    const result = await host({ type: "status" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.reply).toMatchObject({ state: "on", allow: ["rust"], redditBlockedByHosts: false, reload: false });
    expect(await read()).toBe(before);
  });

  test("ignores FOCUS_HOSTS_FILE; Chrome's environment can't redirect it", async () => {
    await Bun.write(join(dir, "other"), "127.0.0.1 localhost\n");
    await focus("add", "x.com");
    const result = await host({ type: "status" }, { env: { FOCUS_HOSTS_FILE: join(dir, "other") } });
    expect(result.reply).toMatchObject({ state: "on" });
  });

  test("refuses to run as root", async () => {
    const result = await host({ type: "status" }, { isRoot: true });
    expect(result.code).toBe(1);
    expect(result.reply).toBeNull();
  });

  test("reports a garbled request on stderr only", async () => {
    const result = await focusWith(
      {
        nativeMessaging: {
          input: async function* () {
            yield new Uint8Array([1, 0]);
          },
          output: async () => {
            throw new Error("nothing should be written");
          },
        },
      },
      "chrome-extension://ppkaiojneebcgfinkmccagdflccineob/",
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stdin closed");
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
