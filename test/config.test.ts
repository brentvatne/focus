import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveConfigPath } from "../src/config.ts";

describe("resolveConfigPath", () => {
  const neverLookup = async () => {
    throw new Error("should not look up a home directory");
  };

  test("prefers $FOCUS_CONFIG", async () => {
    const env = { FOCUS_CONFIG: "/x/focus.json", XDG_CONFIG_HOME: "/xdg", HOME: "/Users/me" };
    expect(await resolveConfigPath(env, 501, neverLookup)).toBe("/x/focus.json");
  });

  test("then $XDG_CONFIG_HOME", async () => {
    expect(await resolveConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/Users/me" }, 501, neverLookup)).toBe(
      "/xdg/focus/config.json",
    );
  });

  test("then ~/.config", async () => {
    expect(await resolveConfigPath({ HOME: "/Users/me" }, 501, neverLookup)).toBe("/Users/me/.config/focus/config.json");
  });

  test("uses the invoking user's home under sudo", async () => {
    const env = { HOME: "/var/root", SUDO_USER: "me" };
    const lookup = async (user: string) => (user === "me" ? "/Users/me" : null);
    expect(await resolveConfigPath(env, 0, lookup)).toBe("/Users/me/.config/focus/config.json");
  });

  test("falls back to $HOME if the sudo user's home can't be found", async () => {
    const env = { HOME: "/var/root", SUDO_USER: "ghost" };
    expect(await resolveConfigPath(env, 0, async () => null)).toBe("/var/root/.config/focus/config.json");
  });

  test("ignores SUDO_USER when not running as root", async () => {
    expect(await resolveConfigPath({ HOME: "/Users/me", SUDO_USER: "other" }, 501, neverLookup)).toBe(
      "/Users/me/.config/focus/config.json",
    );
  });

  test("ignores SUDO_USER=root", async () => {
    expect(await resolveConfigPath({ HOME: "/var/root", SUDO_USER: "root" }, 0, neverLookup)).toBe(
      "/var/root/.config/focus/config.json",
    );
  });
});

describe("loadConfig", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "focus-config-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("uses defaults when the file is missing", async () => {
    expect(await loadConfig(path)).toEqual({ path, found: false, config: DEFAULT_CONFIG });
  });

  test("overrides only the keys that are set", async () => {
    await Bun.write(path, JSON.stringify({ flushDns: false }));
    expect(await loadConfig(path)).toEqual({ path, found: true, config: { exact: false, flushDns: false } });
  });

  test.each([
    ["", /invalid JSON/],
    ["null", /expected a JSON object/],
    ['{ "exact": 1 }', /'exact' must be true or false/],
    ['{ "hostsFile": "/etc/sudoers" }', /unknown key 'hostsFile'/],
  ])("rejects %p", async (content, message) => {
    await Bun.write(path, content);
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(path)).rejects.toThrow(message);
  });
});
