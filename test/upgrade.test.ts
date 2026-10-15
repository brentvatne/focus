import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET, CHECKSUMS, UpgradeError, type UpgradeDeps, compareVersions, upgrade } from "../src/upgrade.ts";

const NEW_BINARY = new TextEncoder().encode("new focus binary");
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

let dir: string;
let binary: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "focus-upgrade-")));
  binary = join(dir, "focus");
  await Bun.write(binary, "old focus binary");
  await chmod(binary, 0o755);
});

afterEach(async () => {
  await chmod(dir, 0o755);
  await rm(dir, { recursive: true, force: true });
});

interface FakeGitHub {
  tag?: string;
  status?: number;
  assets?: string[];
  binary?: Uint8Array;
  sums?: string;
}

/** Fakes the GitHub releases API, including the redirect from asset URLs to signed storage URLs. */
function fakeGitHub(options: FakeGitHub = {}) {
  const bytes = options.binary ?? NEW_BINARY;
  const files: Record<string, Uint8Array> = {
    [ASSET]: bytes,
    [CHECKSUMS]: new TextEncoder().encode(options.sums ?? `${sha256(NEW_BINARY)}  ${ASSET}\n`),
  };
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    if (url.endsWith("/releases/latest")) {
      if (options.status) return new Response("", { status: options.status });
      const names = options.assets ?? Object.keys(files);
      return Response.json({
        tag_name: options.tag ?? "v0.2.0",
        assets: names.map((name) => ({ name, url: `https://api.github.com/assets/${name}` })),
      });
    }
    const asset = /\/assets\/(.+)$/.exec(url)?.[1];
    if (asset) return new Response(null, { status: 302, headers: { location: `https://storage.example/${asset}` } });
    const stored = /storage\.example\/(.+)$/.exec(url)?.[1];
    if (stored && files[stored]) return new Response(files[stored]);
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

function deps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    fetch: fakeGitHub().fetch,
    token: async () => "secret",
    binaryPath: binary,
    arch: "arm64",
    runVersion: async () => "0.2.0\n",
    ...overrides,
  };
}

const unchanged = async () => {
  expect(await Bun.file(binary).text()).toBe("old focus binary");
  expect(await readdir(dir)).toEqual(["focus"]);
};

describe("upgrade", () => {
  test("replaces the binary, keeping its mode, and sends the token only to GitHub", async () => {
    const github = fakeGitHub();
    const result = await upgrade("0.1.0", false, deps({ fetch: github.fetch }));
    expect(result).toEqual({ status: "upgraded", current: "0.1.0", latest: "0.2.0", path: binary });
    expect(await Bun.file(binary).bytes()).toEqual(NEW_BINARY);
    expect((await stat(binary)).mode & 0o7777).toBe(0o755);
    expect(await readdir(dir)).toEqual(["focus"]);
    for (const call of github.calls) {
      expect(call.auth).toBe(call.url.startsWith("https://api.github.com/") ? "Bearer secret" : null);
    }
  });

  test("runs the new binary before swapping it in", async () => {
    let ran: string | undefined;
    await upgrade("0.1.0", false, deps({ runVersion: async (path) => ((ran = path), "0.2.0") }));
    expect(ran).not.toBe(binary);
    expect(ran!.startsWith(dir)).toBe(true);
  });

  test("replaces the target of a symlink and keeps the link", async () => {
    const link = join(dir, "focus-link");
    await symlink(binary, link);
    await upgrade("0.1.0", false, deps({ binaryPath: link }));
    expect(await Bun.file(binary).bytes()).toEqual(NEW_BINARY);
  });

  test.each([["v0.1.0"], ["v0.0.9"]])("does nothing when the latest release is %s", async (tag) => {
    const result = await upgrade("0.1.0", false, deps({ fetch: fakeGitHub({ tag }).fetch }));
    expect(result).toEqual({ status: "up-to-date", current: "0.1.0" });
    await unchanged();
  });

  test("dry run only checks", async () => {
    const github = fakeGitHub();
    const result = await upgrade("0.1.0", true, deps({ fetch: github.fetch }));
    expect(result).toEqual({ status: "available", current: "0.1.0", latest: "0.2.0" });
    expect(github.calls).toHaveLength(1);
    await unchanged();
  });

  test.each([
    ["the checksum doesn't match", { fetch: fakeGitHub({ binary: new TextEncoder().encode("evil") }).fetch }, /checksum mismatch/],
    ["SHA256SUMS lacks the asset", { fetch: fakeGitHub({ sums: "abc  other-file\n" }).fetch }, /no entry/],
    ["the asset is missing", { fetch: fakeGitHub({ assets: [CHECKSUMS] }).fetch }, /no focus-darwin-arm64 asset/],
    ["the new binary can't run", { runVersion: async (): Promise<string> => Promise.reject(new Error("killed by SIGKILL")) }, /failed to run \(killed by SIGKILL\)/],
    ["the new binary reports the wrong version", { runVersion: async (): Promise<string> => "0.1.0" }, /expected 0.2.0/],
    ["running from source", { binaryPath: null }, /running from source/],
    ["on Intel", { arch: "x64" }, /only built for Apple silicon/],
  ] as const)("refuses when %s", async (_, overrides, message) => {
    const promise = upgrade("0.1.0", false, deps(overrides));
    await expect(promise).rejects.toThrow(UpgradeError);
    await expect(upgrade("0.1.0", false, deps(overrides))).rejects.toThrow(message);
    await unchanged();
  });

  test("explains how to authenticate when the repo isn't visible", async () => {
    const fetch = fakeGitHub({ status: 404 }).fetch;
    await expect(upgrade("0.1.0", false, deps({ fetch, token: async () => null }))).rejects.toThrow(/gh auth login/);
    await expect(upgrade("0.1.0", false, deps({ fetch }))).rejects.toThrow(/no releases found/);
  });

  test("asks for sudo when the binary's directory isn't writable", async () => {
    if (process.getuid?.() === 0) return;
    await chmod(dir, 0o555);
    await expect(upgrade("0.1.0", false, deps())).rejects.toThrow(/sudo focus upgrade/);
    await chmod(dir, 0o755);
    await unchanged();
  });
});

test.each([
  ["0.2.0", "0.1.0", 1],
  ["0.10.0", "0.9.0", 1],
  ["1.0.0", "1.0.0", 0],
  ["1.0", "1.0.0", 0],
  ["0.1.0", "0.1.1", -1],
  ["1.0.0-beta.1", "1.0.0", 0],
])("compareVersions(%p, %p) has sign %p", (a, b, sign) => {
  expect(Math.sign(compareVersions(a, b))).toBe(sign);
});
