import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAtomically } from "./hostsfile.ts";

/** The native-messaging host name the extension asks Chrome for. */
export const NATIVE_HOST_NAME = "com.brentvatne.focus";

/** What `focus reddit install` copies into the folder Chrome loads. Nothing else in extension/ ships. */
export const EXTENSION_FILES = ["manifest.json", "background.js", "rules.js", "comments.js", "blocked.html", "blocked.js"];

export interface ChromeDeps {
  /** The subreddit allowlist (see subreddits.ts). */
  allowlistPath: string;
  /** Where the extension's files are read from: embedded in the binary, or extension/ from source. */
  extensionSource: string;
  /** The folder focus writes and Chrome loads with "Load unpacked". */
  extensionDir: string;
  /** Chrome's per-user NativeMessagingHosts folder. */
  nativeHostsDir: string;
  openFolder(path: string): Promise<void>;
}

export function defaultChromePaths(home = homedir()) {
  const support = join(home, "Library", "Application Support");
  return {
    extensionDir: join(support, "focus", "chrome-extension"),
    nativeHostsDir: join(support, "Google", "Chrome", "NativeMessagingHosts"),
  };
}

/** Chrome's extension id for a manifest `key`: the first 128 bits of its SHA-256, as letters a-p. */
export function extensionId(key: string): string {
  const hex = new Bun.CryptoHasher("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

/** Chrome's `version` is one to four integers; a prerelease suffix goes in `version_name` instead. */
export function chromeVersion(version: string): string {
  return /^\d+(\.\d+){0,3}/.exec(version)?.[0] ?? "0";
}

export async function readExtensionId(source: string): Promise<string> {
  const manifest = (await Bun.file(join(source, "manifest.json")).json()) as { key?: string };
  if (!manifest.key) throw new Error(`${source}/manifest.json has no key`);
  return extensionId(manifest.key);
}

export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/**
 * Writes the extension, stamped with `version`, into `target`. The files go into a
 * staging folder first, which then replaces `target`, so Chrome never loads a mix of
 * two versions.
 */
export async function writeExtension(source: string, target: string, version: string): Promise<void> {
  const staging = `${target}.focus-${process.pid}.staging`;
  const previous = `${target}.focus-${process.pid}.old`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const name of EXTENSION_FILES) {
      let content: string | Uint8Array = await Bun.file(join(source, name)).bytes();
      if (name === "manifest.json") {
        const manifest = JSON.parse(new TextDecoder().decode(content));
        manifest.version = chromeVersion(version);
        manifest.version_name = version;
        content = JSON.stringify(manifest, null, 2) + "\n";
      }
      await Bun.write(join(staging, name), content);
    }
    const replacing = await isDirectory(target);
    if (replacing) await rename(target, previous);
    await rename(staging, target);
    if (replacing) await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function nativeHostManifestPath(nativeHostsDir: string): string {
  return join(nativeHostsDir, `${NATIVE_HOST_NAME}.json`);
}

/** Registers `binary` with Chrome as the native-messaging host, for the extension with `id` only. */
export async function writeNativeHostManifest(nativeHostsDir: string, binary: string, id: string): Promise<string> {
  const path = nativeHostManifestPath(nativeHostsDir);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "focus: tells the Chrome extension whether blocking is on and which subreddits are allowed",
    path: binary,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  };
  await mkdir(dirname(path), { recursive: true });
  await writeAtomically(path, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o644,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  return path;
}

/** Removes only what `focus reddit install` wrote. The allowlist stays. */
export async function removeChromeFiles(deps: Pick<ChromeDeps, "extensionDir" | "nativeHostsDir">): Promise<string[]> {
  const removed: string[] = [];
  const manifest = nativeHostManifestPath(deps.nativeHostsDir);
  if (await Bun.file(manifest).exists()) {
    await rm(manifest);
    removed.push(manifest);
  }
  if (await isDirectory(deps.extensionDir)) {
    await rm(deps.extensionDir, { recursive: true });
    removed.push(deps.extensionDir);
  }
  return removed;
}
