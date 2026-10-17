import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../extension/rules.js";
import { EXTENSION_FILES, chromeVersion, extensionId, readExtensionId, writeExtension } from "../src/chrome.ts";
import { MAX_MESSAGE_BYTES, type StatusReply, encodeMessage, readMessage, respond } from "../src/nativehost.ts";

const EXTENSION_SOURCE = join(import.meta.dir, "..", "extension");

async function* chunks(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

describe("framing", () => {
  test("length is a little-endian uint32 before the JSON", () => {
    const frame = encodeMessage({ a: 1 });
    expect([...frame.subarray(0, 4)]).toEqual([7, 0, 0, 0]);
    expect(new TextDecoder().decode(frame.subarray(4))).toBe('{"a":1}');
  });

  test("reads a message split across chunks, without waiting for the stream to end", async () => {
    const frame = encodeMessage({ type: "status", extensionVersion: "1.2.3" });
    async function* neverEnds() {
      yield frame.subarray(0, 2);
      yield frame.subarray(2, 9);
      yield frame.subarray(9);
      await new Promise(() => {}); // Chrome keeps stdin open until it has the reply
    }
    expect(await readMessage(neverEnds())).toEqual({ type: "status", extensionVersion: "1.2.3" });
  });

  test("refuses oversized and truncated messages", async () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_MESSAGE_BYTES + 1, true);
    await expect(readMessage(chunks(header))).rejects.toThrow(/too large/);
    await expect(readMessage(chunks(encodeMessage({ a: 1 }).subarray(0, 6)))).rejects.toThrow(/closed/);
    expect(() => encodeMessage("x".repeat(MAX_MESSAGE_BYTES))).toThrow(/1 MB/);
  });
});

describe("respond", () => {
  let dir: string;
  let hosts: string;
  let allowlist: string;
  const deps = () => ({
    systemHostsFile: hosts,
    allowlistPath: allowlist,
    feedsPath: join(dir, "feeds.json"),
    extensionSource: EXTENSION_SOURCE,
    extensionDir: join(dir, "chrome-extension"),
    version: "9.9.9",
    log: () => {},
  });
  const section = (state: string, ...hostsListed: string[]) =>
    `127.0.0.1 localhost\n# BEGIN focus\n# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.\n# state: ${state}\n# sites\n` +
    hostsListed.map((h) => `${state === "on" ? "" : "# "}0.0.0.0 ${h}\n${state === "on" ? "" : "# "}:: ${h}\n`).join("") +
    "# END focus\n";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "focus-host-"));
    hosts = join(dir, "hosts");
    allowlist = join(dir, "subreddits.json");
    await Bun.write(allowlist, '{"version":1,"allow":["rust"]}');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each([
    ["on", section("on", "x.com"), false],
    ["off", section("off", "x.com"), false],
    ["on", section("on", "x.com", "reddit.com"), true],
    ["none", "127.0.0.1 localhost\n", false],
  ])("reports %s", async (state, content, redditBlockedByHosts) => {
    await Bun.write(hosts, content);
    expect(await respond({ type: "status" }, deps())).toEqual({
      protocol: PROTOCOL,
      version: "9.9.9",
      state,
      reddit: true,
      allow: ["rust"],
      feeds: [],
      redditBlockedByHosts,
      reload: false,
    } as never);
  });

  test("reports the feeds, and limits Reddit only once there's an allowlist", async () => {
    await Bun.write(hosts, section("on", "a.com"));
    await Bun.write(join(dir, "feeds.json"), '{"version":1,"feeds":["x"]}');
    await rm(allowlist);
    expect(await respond({ type: "status" }, deps())).toMatchObject({ state: "on", reddit: false, allow: [], feeds: ["x"] });
  });

  test("a broken feeds file blocks every feed and says why", async () => {
    await Bun.write(hosts, section("off", "a.com"));
    await Bun.write(join(dir, "feeds.json"), "{ nope");
    const reply = await respond({ type: "status" }, deps());
    expect(reply).toMatchObject({ state: "off", feeds: ["youtube", "x", "instagram"], feedsError: expect.stringMatching(/invalid JSON/) });
    expect(reply).not.toHaveProperty("error");
  });

  test("an empty section, kept for Chrome settings alone, still reports its state", async () => {
    await Bun.write(hosts, "127.0.0.1 localhost\n# BEGIN focus\n# state: on\n# END focus\n");
    expect(await respond({ type: "status" }, deps())).toMatchObject({ state: "on" });
    await Bun.write(hosts, "127.0.0.1 localhost\n# BEGIN focus\n# state: off\n# END focus\n");
    expect(await respond({ type: "status" }, deps())).toMatchObject({ state: "off" });
  });

  test("reports a malformed section as an error, never as off", async () => {
    await Bun.write(hosts, "# BEGIN focus\n0.0.0.0 x.com\n");
    expect(await respond({ type: "status" }, deps())).toMatchObject({ state: "error", error: expect.stringMatching(/malformed/) });
  });

  test("a malformed allowlist allows nothing but keeps the real state, so off still means off", async () => {
    await Bun.write(allowlist, '{"version":1,"allow":["all"]}');
    for (const state of ["on", "off"] as const) {
      await Bun.write(hosts, section(state, "x.com"));
      const reply = await respond({ type: "status" }, deps());
      expect(reply).toMatchObject({ state, allow: [], allowlistError: expect.stringMatching(/feed/) });
      expect(reply).not.toHaveProperty("error");
    }
  });

  test("refuses anything but a status request", async () => {
    expect(await respond({ type: "write", path: "/etc/hosts" }, deps())).toEqual({ error: "focus only answers status requests" });
    expect(await respond(null, deps())).toEqual({ error: "focus only answers status requests" });
  });

  test("refreshes an installed extension from another version, and only that", async () => {
    await Bun.write(hosts, section("on", "x.com"));
    const reload = async (request: object) => ((await respond({ type: "status", ...request }, deps())) as StatusReply).reload;
    // Not installed: nothing to refresh.
    expect(await reload({ extensionVersion: "1.0.0" })).toBe(false);

    await writeExtension(EXTENSION_SOURCE, join(dir, "chrome-extension"), "1.0.0");
    // A development copy loaded from source has no version_name, so it's never rewritten.
    expect(await reload({})).toBe(false);
    expect(await reload({ extensionVersion: "9.9.9" })).toBe(false);

    expect(await reload({ extensionVersion: "1.0.0" })).toBe(true);
    const manifest = await Bun.file(join(dir, "chrome-extension", "manifest.json")).json();
    expect(manifest.version_name).toBe("9.9.9");
  });
});

describe("extension files", () => {
  test("the id is derived from the manifest key", async () => {
    expect(await readExtensionId(EXTENSION_SOURCE)).toBe("ppkaiojneebcgfinkmccagdflccineob");
    expect(extensionId("")).toMatch(/^[a-p]{32}$/);
  });

  test("Chrome's version drops prerelease suffixes", () => {
    expect(chromeVersion("0.2.0")).toBe("0.2.0");
    expect(chromeVersion("0.2.0-rc.1")).toBe("0.2.0");
    expect(chromeVersion("1.2.3.4.5")).toBe("1.2.3.4");
  });

  test("ships every file in extension/ but its tsconfig", async () => {
    const files = (await readdir(EXTENSION_SOURCE)).filter((name) => name !== "tsconfig.json");
    expect([...EXTENSION_FILES].sort()).toEqual(files.sort());
  });

  test("writes only the shipped files, stamped, replacing an older copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focus-ext-"));
    try {
      const target = join(dir, "chrome-extension");
      await writeExtension(EXTENSION_SOURCE, target, "0.1.0");
      await Bun.write(join(target, "stale.js"), "old");
      await writeExtension(EXTENSION_SOURCE, target, "0.2.0-rc.1");
      expect((await readdir(target)).sort()).toEqual([...EXTENSION_FILES].sort());
      const manifest = await Bun.file(join(target, "manifest.json")).json();
      expect(manifest).toMatchObject({ version: "0.2.0", version_name: "0.2.0-rc.1", manifest_version: 3 });
      expect(await readdir(dir)).toEqual(["chrome-extension"]); // no staging or old copies left behind
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
