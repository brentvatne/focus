// Builds the release assets: a signed, self-contained arm64 binary and its checksum.
import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ASSET, CHECKSUMS } from "../src/upgrade.ts";
import { VERSION } from "../src/version.ts";

const outDir = join(import.meta.dir, "..", "dist", "release");
const binary = join(outDir, ASSET);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await $`bun build --compile --minify --target=bun-darwin-arm64 src/cli.ts --asset ./extension --outfile ${binary}`.cwd(join(import.meta.dir, ".."));
// Bun's embedded ad-hoc signature is invalid once the bundle is appended, and macOS kills unsigned arm64 binaries.
await $`codesign --sign - --force ${binary}`;

const reported = (await $`${binary} --version`.text()).trim();
if (reported !== VERSION) throw new Error(`built binary reports ${reported}, expected ${VERSION}`);

const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(binary).bytes()).digest("hex");
await Bun.write(join(outDir, CHECKSUMS), `${digest}  ${ASSET}\n`);
console.log(`Built focus ${VERSION}: ${binary}`);
