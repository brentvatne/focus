import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SudoSetupError, checkBinaryIsSafe, sudoersRule } from "../src/sudo.ts";

describe("sudoersRule", () => {
  test("allows only the one binary, as root, without a password", () => {
    expect(sudoersRule("brent", "/usr/local/bin/focus").split("\n")).toContain(
      "brent ALL=(root) NOPASSWD: /usr/local/bin/focus",
    );
  });

  test("passes visudo's syntax check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focus-sudoers-"));
    try {
      const path = join(dir, "focus");
      await Bun.write(path, sudoersRule("first.last", "/usr/local/bin/focus"));
      expect((await Bun.$`/usr/sbin/visudo -cf ${path}`.quiet().nothrow()).exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["a user with sudoers syntax", "brent ALL=(ALL) ALL\nbrent", "/usr/local/bin/focus"],
    ["a user with spaces", "brent vatne", "/usr/local/bin/focus"],
    ["a path with spaces", "brent", "/Applications/My Tools/focus"],
    ["a path with sudoers syntax", "brent", "/usr/local/bin/focus, ALL"],
    ["a relative path", "brent", "focus"],
  ])("refuses %s", (_, user, path) => {
    expect(() => sudoersRule(user, path)).toThrow(SudoSetupError);
  });
});

describe("checkBinaryIsSafe", () => {
  let dir: string;
  let binary: string;
  const uid = process.getuid!();

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "focus-binary-")));
    binary = join(dir, "focus");
    await Bun.write(binary, "binary");
    await chmod(binary, 0o755);
  });

  afterEach(async () => {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  test("accepts a binary owned by a trusted user in a locked-down directory", async () => {
    await checkBinaryIsSafe(binary, uid);
  });

  test("refuses a binary owned by someone untrusted", async () => {
    await expect(checkBinaryIsSafe(binary, uid + 1)).rejects.toThrow(SudoSetupError);
  });

  test.each([[0o775], [0o757]])("refuses a binary with mode %o", async (mode) => {
    await chmod(binary, mode);
    await expect(checkBinaryIsSafe(binary, uid)).rejects.toThrow(/not writable by group or others/);
  });

  test("refuses a binary in a directory others can write to", async () => {
    await chmod(dir, 0o777);
    await expect(checkBinaryIsSafe(binary, uid)).rejects.toThrow(dir);
  });

  test("the real /usr/bin/sudo passes when only root is trusted", async () => {
    await checkBinaryIsSafe("/usr/bin/sudo", 0);
  });
});
