import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Defaults for command-line flags. The block list deliberately isn't here: it
 * lives only in the hosts file, so there's a single source of truth to undo.
 */
export interface Config {
  /** Default for --exact: don't add or remove the www. variant. */
  exact: boolean;
  /** Default for --flush: flush the macOS DNS cache after writing /etc/hosts. */
  flushDns: boolean;
}

export const DEFAULT_CONFIG: Config = { exact: false, flushDns: true };

export class ConfigError extends Error {}

export interface LoadedConfig {
  path: string;
  found: boolean;
  config: Config;
}

/**
 * $FOCUS_CONFIG, else $XDG_CONFIG_HOME/focus/config.json, else
 * ~/.config/focus/config.json. Under sudo, ~ is the invoking user's home, not root's.
 */
export async function resolveConfigPath(
  env: Record<string, string | undefined>,
  uid = process.getuid?.(),
  lookupHome = lookupMacHome,
): Promise<string> {
  if (env.FOCUS_CONFIG) return env.FOCUS_CONFIG;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "focus", "config.json");

  let home = env.HOME ?? homedir();
  if (uid === 0 && env.SUDO_USER && env.SUDO_USER !== "root") {
    home = (await lookupHome(env.SUDO_USER)) ?? home;
  }
  return join(home, ".config", "focus", "config.json");
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { path, found: false, config: { ...DEFAULT_CONFIG } };

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }

  const config = { ...DEFAULT_CONFIG };
  const keys = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key as keyof Config)) {
      throw new ConfigError(`${path}: unknown key '${key}' (expected one of: ${keys.join(", ")})`);
    }
    if (typeof value !== "boolean") {
      throw new ConfigError(`${path}: '${key}' must be true or false`);
    }
    config[key as keyof Config] = value;
  }
  return { path, found: true, config };
}

async function lookupMacHome(user: string): Promise<string | null> {
  const output = await Bun.$`dscl . -read ${`/Users/${user}`} NFSHomeDirectory`.quiet().nothrow().text();
  return /^NFSHomeDirectory:\s*(\S.*)$/m.exec(output)?.[1]?.trim() ?? null;
}
