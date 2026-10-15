import { stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { type FileOwner, writeAtomically } from "./hostsfile.ts";

export const SUDOERS_FILE = "/etc/sudoers.d/focus";

export class SudoSetupError extends Error {}

export interface SudoersDeps {
  /** Where the rule goes. sudo ignores files in sudoers.d whose names contain a dot, like our temp files. */
  path: string;
  /** Mode and owner for the rule file: 0440 root:wheel in production. */
  owner: FileOwner;
  /** Besides root, the uid allowed to own the binary and the directories above it. 0 in production; tests use their own. */
  trustedUid: number;
  /** Throws if the rule file at `path` isn't valid sudoers syntax (`visudo -cf`). */
  validate(path: string): Promise<void>;
  /** Resolves to true if sudo now lets `user` run `binary` without a password. */
  verify(user: string, binary: string): Promise<boolean>;
}

const USERNAME = /^[a-z_][a-z0-9_.-]*$/i;
// Anything outside this set would need sudoers escaping, so it's refused instead.
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

export function sudoersRule(user: string, binary: string): string {
  if (!USERNAME.test(user)) throw new SudoSetupError(`refusing to write a sudoers rule for the user '${user}'`);
  if (!SAFE_PATH.test(binary)) throw new SudoSetupError(`refusing to write a sudoers rule for the path '${binary}'`);
  return [
    `# Installed by \`focus setup-sudo\` so ${user} can run focus as root without a password.`,
    "# Undo with `focus setup-sudo --remove` or `sudo rm /etc/sudoers.d/focus`.",
    `${user} ALL=(root) NOPASSWD: ${binary}`,
    "",
  ].join("\n");
}

/**
 * A passwordless rule is only as safe as the binary it names: if your user could
 * replace the file, anything running as you could become root. So the binary and
 * every directory above it must be owned by root and not writable by anyone else.
 */
export async function checkBinaryIsSafe(binary: string, trustedUid: number): Promise<void> {
  for (let path = binary; ; path = dirname(path)) {
    const info = await stat(path);
    if ((info.uid !== 0 && info.uid !== trustedUid) || (info.mode & 0o022) !== 0) {
      throw new SudoSetupError(
        `${path} must be owned by root and not writable by group or others before focus can run without a password. ` +
          "Reinstall focus with install.sh, which puts it in /usr/local/bin.",
      );
    }
    if (path === dirname(path)) return;
  }
}

export async function installSudoersRule(user: string, binary: string, deps: SudoersDeps): Promise<void> {
  await checkBinaryIsSafe(binary, deps.trustedUid);
  const rule = sudoersRule(user, binary);
  await writeAtomically(deps.path, rule, deps.owner, (temp) => deps.validate(temp));
  if (!(await deps.verify(user, binary))) {
    await unlink(deps.path).catch(() => {});
    throw new SudoSetupError(
      `sudo didn't pick up ${deps.path}, so it was removed again. Check that /etc/sudoers includes /private/etc/sudoers.d.`,
    );
  }
}

/** Resolves to true if a rule was removed. */
export async function removeSudoersRule(deps: Pick<SudoersDeps, "path">): Promise<boolean> {
  try {
    await unlink(deps.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
