import { realpath, stat } from "node:fs/promises";
import { writeAtomically } from "./hostsfile.ts";

export const REPO = "brentvatne/focus";
export const ASSET = "focus-darwin-arm64";
export const CHECKSUMS = "SHA256SUMS";

export class UpgradeError extends Error {}

export interface UpgradeDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** A GitHub token, needed while the repo is private. */
  token(): Promise<string | null>;
  /** Path of the running compiled binary, or null when running from source. */
  binaryPath: string | null;
  arch: string;
  /** Runs `<path> --version` and returns its output; throws if it can't run. */
  runVersion(path: string): Promise<string>;
  /** Told what's happening, for a progress display. */
  progress?(event: UpgradeProgress): void;
}

export type UpgradeProgress =
  | { step: "checking" }
  /** `total` is null when GitHub doesn't say how big the download is. */
  | { step: "downloading"; version: string; received: number; total: number | null }
  | { step: "verifying"; version: string }
  | { step: "installing"; version: string; path: string };

export type UpgradeResult =
  | { status: "up-to-date"; current: string }
  | { status: "available"; current: string; latest: string }
  | { status: "upgraded"; current: string; latest: string; path: string };

interface Release {
  tag_name: string;
  assets: { name: string; url: string }[];
}

/** Replaces the running binary with the latest GitHub release, or only checks when dryRun is set. */
export async function upgrade(current: string, dryRun: boolean, deps: UpgradeDeps): Promise<UpgradeResult> {
  if (deps.arch !== "arm64") throw new UpgradeError(`releases are only built for Apple silicon (arm64), not ${deps.arch}`);
  const progress = deps.progress ?? (() => {});
  progress({ step: "checking" });

  const token = await deps.token();
  const headers = (accept: string): Record<string, string> => ({
    Accept: accept,
    "User-Agent": `focus/${current}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  const response = await deps.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: headers("application/vnd.github+json"),
  });
  if (response.status === 404) {
    throw new UpgradeError(
      token
        ? `no releases found for ${REPO}`
        : `couldn't find releases for ${REPO}. While the repo is private, log in with \`gh auth login\` or set GITHUB_TOKEN.`,
    );
  }
  if (!response.ok) throw new UpgradeError(`GitHub API returned ${response.status} for ${REPO} releases`);
  const release = (await response.json()) as Release;

  const latest = release.tag_name.replace(/^v/, "");
  if (compareVersions(latest, current) <= 0) return { status: "up-to-date", current };
  if (dryRun) return { status: "available", current, latest };

  if (!deps.binaryPath) {
    throw new UpgradeError("focus is running from source; upgrade only replaces an installed release binary");
  }

  const download = async (name: string, onChunk?: (received: number, total: number | null) => void): Promise<Uint8Array> => {
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new UpgradeError(`release ${release.tag_name} has no ${name} asset`);
    // Asset URLs redirect to signed storage URLs that reject a second Authorization header.
    let res = await deps.fetch(asset.url, { headers: headers("application/octet-stream"), redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) res = await deps.fetch(location);
    if (!res.ok) throw new UpgradeError(`downloading ${name} failed with HTTP ${res.status}`);
    if (!onChunk || !res.body) return new Uint8Array(await res.arrayBuffer());
    const length = Number(res.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    onChunk(0, total);
    for await (const chunk of res.body) {
      chunks.push(chunk);
      received += chunk.length;
      onChunk(received, total);
    }
    return Buffer.concat(chunks);
  };

  const [binary, sums] = await Promise.all([
    download(ASSET, (received, total) => progress({ step: "downloading", version: latest, received, total })),
    download(CHECKSUMS),
  ]);
  progress({ step: "verifying", version: latest });
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === ASSET)?.[0];
  const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  if (!expected) throw new UpgradeError(`${CHECKSUMS} has no entry for ${ASSET}`);
  if (actual !== expected) throw new UpgradeError(`checksum mismatch for ${ASSET}; nothing was replaced`);

  const path = await realpath(deps.binaryPath);
  const info = await stat(path);
  progress({ step: "installing", version: latest, path });
  try {
    await writeAtomically(path, binary, { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid }, async (temp) => {
      const output = await deps.runVersion(temp).catch((error) => {
        throw new UpgradeError(`the downloaded binary failed to run (${(error as Error).message}); nothing was replaced`);
      });
      if (output.trim() !== latest) {
        throw new UpgradeError(`the downloaded binary reports version '${output.trim()}', expected ${latest}`);
      }
    });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EACCES" || code === "EPERM") {
      throw new UpgradeError(`permission denied replacing ${path}. Run \`sudo focus upgrade\`.`);
    }
    throw error;
  }
  return { status: "upgraded", current, latest, path };
}

/** Compares dotted numeric versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
