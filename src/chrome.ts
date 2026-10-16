import { mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAtomically } from "./hostsfile.ts";

/** The native-messaging host name the extension asks Chrome for. */
export const NATIVE_HOST_NAME = "com.brentvatne.focus";

/** What `focus chrome install` copies into the folder Chrome loads. Nothing else in extension/ ships. */
export const EXTENSION_FILES = [
  "manifest.json",
  "background.js",
  "rules.js",
  "comments.js",
  "youtube.js",
  "youtube.css",
  "blocked.html",
  "blocked.js",
];

export interface ChromeDeps {
  /** The subreddit allowlist (see subreddits.ts). */
  allowlistPath: string;
  /** The sites whose feeds are blocked (see feeds.ts). */
  feedsPath: string;
  /** Where the extension's files are read from: embedded in the binary, or extension/ from source. */
  extensionSource: string;
  /** The folder focus writes and Chrome loads with "Load unpacked". */
  extensionDir: string;
  /** Chrome's per-user NativeMessagingHosts folder. */
  nativeHostsDir: string;
  /** Chrome's user data folder, with a folder per profile. focus only ever reads it. */
  profilesDir: string;
  /** Opens a Finder window with `path` selected, ready to drag. */
  reveal(path: string): Promise<void>;
  /**
   * Opens a URL in Google Chrome; resolves false if that didn't work (Chrome isn't installed).
   * Chrome accepts chrome:// pages only this way: it ignores them as command-line arguments,
   * and it doesn't register the chrome: scheme, so a terminal link to one can't open.
   */
  openInChrome(url: string): Promise<boolean>;
  /** Resolves false if it couldn't copy. */
  copyToClipboard(text: string): Promise<boolean>;
}

export function defaultChromePaths(home = homedir()) {
  const support = join(home, "Library", "Application Support");
  return {
    extensionDir: join(support, "focus", "chrome-extension"),
    nativeHostsDir: join(support, "Google", "Chrome", "NativeMessagingHosts"),
    profilesDir: join(support, "Google", "Chrome"),
  };
}

export interface LoadedExtension {
  /** The profile's name as Chrome shows it, e.g. "Person 1". */
  profile: string;
  incognito: boolean;
}

/**
 * The Chrome profiles that have the extension in `extensionDir` loaded (with Load unpacked),
 * from each profile's Secure Preferences. Chrome saves these about 10 seconds after a change.
 * Read only. Null when focus isn't allowed to read them (a sandbox, or macOS privacy settings),
 * so "can't tell" never looks like "not loaded".
 */
export async function findLoadedExtension(
  profilesDir: string,
  id: string,
  extensionDir: string,
): Promise<LoadedExtension[] | null> {
  const target = await realpath(extensionDir).catch(() => extensionDir);
  const denied = (error: unknown) => ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
  let folders: string[];
  try {
    folders = await readdir(profilesDir);
  } catch (error) {
    if (denied(error)) return null;
    return []; // No Chrome profiles at all.
  }
  const localState = await readJson(join(profilesDir, "Local State")).catch(() => null);
  const names: Record<string, { name?: unknown }> = localState?.profile?.info_cache ?? {};
  const found: LoadedExtension[] = [];
  let unreadable = false;
  for (const folder of folders.filter((name) => name === "Default" || /^Profile \d+$/.test(name)).sort()) {
    let prefs;
    try {
      prefs = await readJson(join(profilesDir, folder, "Secure Preferences"));
    } catch (error) {
      if (denied(error)) unreadable = true;
      continue; // Missing, or caught mid-write: Chrome will have saved it by the next look.
    }
    const entry = prefs?.extensions?.settings?.[id];
    if (typeof entry?.path !== "string") continue;
    const path = await realpath(entry.path).catch(() => entry.path);
    if (path !== target) continue;
    const name = names[folder]?.name;
    found.push({ profile: typeof name === "string" ? name : folder, incognito: entry.incognito === true });
  }
  return found.length === 0 && unreadable ? null : found;
}

// Bun.file().json() hides the error code that tells "not allowed" from "not there".
async function readJson(path: string): Promise<any> {
  const handle = await open(path, "r");
  try {
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** The focus version whose extension files are in `extensionDir`, or null if there are none. */
export async function installedExtensionVersion(extensionDir: string): Promise<string | null> {
  const manifest = await readJson(join(extensionDir, "manifest.json")).catch(() => null);
  return typeof manifest?.version_name === "string" ? manifest.version_name : null;
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
    try {
      await rename(staging, target);
    } catch (error) {
      // Put the working copy back; Chrome disables an unpacked extension whose folder is gone.
      if (replacing && !(await isDirectory(target))) await rename(previous, target).catch(() => {});
      throw error;
    } finally {
      // Never delete the old copy while it's the only one.
      if (await isDirectory(target)) await rm(previous, { recursive: true, force: true });
    }
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

/** Removes only what `focus chrome install` wrote. Your settings stay. */
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
