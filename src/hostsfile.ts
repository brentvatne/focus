import { chown, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const SYSTEM_HOSTS_FILE = "/etc/hosts";

export interface HostsSnapshot {
  /** The file actually written: symlinks (including /etc -> /private/etc) resolved. */
  path: string;
  content: string;
  mode: number;
  uid: number;
  gid: number;
}

export class ConcurrentModificationError extends Error {}

export async function readHostsFile(path: string): Promise<HostsSnapshot> {
  const resolved = await realpath(path);
  const info = await stat(resolved);
  return {
    path: resolved,
    content: await Bun.file(resolved).text(),
    mode: info.mode & 0o7777,
    uid: info.uid,
    gid: info.gid,
  };
}

/** Where the previous contents are saved before each write. */
export function backupPath(snapshot: HostsSnapshot): string {
  return `${snapshot.path}.focus-backup`;
}

/**
 * Replaces the hosts file with `content`. The previous contents are saved to
 * backupPath() first, then the new file is written to a temp file next to the
 * original (same mode and owner), fsynced and renamed into place, so the hosts
 * file is never observed half-written.
 */
export async function writeHostsFile(snapshot: HostsSnapshot, content: string): Promise<void> {
  await writeAtomically(backupPath(snapshot), snapshot.content, snapshot);

  // Don't clobber edits made by someone else between our read and now.
  const current = await Bun.file(snapshot.path).text();
  if (current !== snapshot.content) {
    throw new ConcurrentModificationError(`${snapshot.path} changed while focus was updating it; nothing was written.`);
  }
  await writeAtomically(snapshot.path, content, snapshot);
}

export interface FileOwner {
  mode: number;
  uid: number;
  gid: number;
}

/**
 * Writes `content` to a temp file beside `path` with the given mode and owner,
 * fsyncs it, runs `verify` on the temp file, then renames it over `path`.
 */
export async function writeAtomically(
  path: string,
  content: string | Uint8Array,
  owner: FileOwner,
  verify?: (tempPath: string) => Promise<void>,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.focus-${process.pid}.tmp`);
  try {
    const handle = await open(temp, "wx", owner.mode);
    try {
      await handle.writeFile(content);
      // The process umask may have masked bits off the mode passed to open().
      await handle.chmod(owner.mode);
      const info = await handle.stat();
      if (info.uid !== owner.uid || info.gid !== owner.gid) await chown(temp, owner.uid, owner.gid);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await verify?.(temp);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
