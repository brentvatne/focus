# AGENTS.md

This file covers what you need to know to work on focus. User documentation is split in two. `README.md` is a deliberately minimal intro: install, the main commands, two screenshots and the essential recovery command. `docs/guide.md` is the full reference: presets, config, running without a password, how it works, manual recovery, development and releasing. Read the guide before changing behaviour, and keep the README short.

## What this is

focus is a macOS CLI written in Bun and TypeScript. It blocks websites by managing one marked section of `/etc/hosts`.
- **Commands:** `init`, `config`, `add`, `remove`/`rm` (both take hostnames and preset names; `--preset` forces preset names), `on`, `off`, `status`, `sync`, `feeds add|remove|list`, `reddit allow|disallow|list` (and `install`/`uninstall` as aliases), `chrome install|update|uninstall`, `upgrade`/`self-update`, `setup-sudo` and `version`. `focus` with no command toggles `on`/`off`, or shows help when nothing is listed.
- **Finer blocking in Chrome:** a Chrome extension in `extension/` blocks only the feeds of YouTube and X, limits Instagram to messages, and limits Reddit to an allowlist of subreddits, while focus is on. The focus binary is its native-messaging host. It's a separate component from the hosts file; see the guide's "Finer blocking in Chrome".
- **Distribution:** a self-contained, ad-hoc-signed arm64 binary, published as GitHub releases from the public repo `brentvatne/focus`.
- **v1 scope:** v1 must stay reversible. It deliberately has no timers, daemons, schedules or anti-tampering features. Don't add these unless asked.

## Commands

```bash
bun install
bun test               # all tests, about 0.1 seconds
bun run typecheck      # tsc --noEmit (src, scripts, test), then extension/ with its own tsconfig
bun run build          # dev binary at dist/focus (signed)
bun run build:release  # dist/release/focus-darwin-arm64 + SHA256SUMS (what CI publishes)
bun src/cli.ts --hosts-file /tmp/some-copy status   # run from source against a copy
```

Use Bun, not Node: run with `bun`, test with `bun:test`, use `Bun.file`/`Bun.write` for simple reads and writes, and `Bun.$` for shell commands. `node:fs/promises` is only for what Bun lacks: `open`/`fsync`, `chmod`/`chown`, `rename` and `realpath`.

## Hard rules

1. **Never touch the real `/etc/hosts`,** not in tests, demos or manual checks. Copy it to a temp or scratch directory and pass `--hosts-file` or `FOCUS_HOSTS_FILE`. A good habit is to run `shasum /etc/hosts` before and after any session that exercises the CLI.
2. **Tests must stay hermetic.** The `focus()` helper in `test/cli.test.ts` always sets:
   - `FOCUS_HOSTS_FILE` and `FOCUS_CONFIG` to files in a fresh temp directory;
   - a `flushDns` spy;
   - an `upgrade` stub that throws.

   It also sets `isRoot: false`, a `systemHostsFile` path inside the temp dir that doesn't exist, and `elevate`/`sudoers` stubs that throw. `chrome` points the subreddit allowlist, the feeds file, the extension folder, Chrome's `NativeMessagingHosts` folder and Chrome's profiles into the temp dir, with `reveal`, `openInChrome` and `copyToClipboard` stubs that throw (so nothing opens your Chrome or changes your clipboard). `nativeMessaging`, `sleep` and `readKey` have stubs that throw. `choose` and `askText` are absent unless a test passes them, as without a terminal.

   Keep all of these. A test that drops one could reach `/etc/hosts`, your real `~/.config/focus/config.json` or `~/Library`, GitHub or sudo. Tests that exercise root behaviour point `systemHostsFile` at the temp hosts file instead of the real one.
3. **Never run real sudo from an agent session.** That includes the elevation path, because a cached sudo login would let it rewrite the real `/etc/hosts`. If you must check that the elevation path is wired up, first confirm `/usr/bin/sudo -n true` fails, then run with stdin redirected from `/dev/null`, so sudo refuses before anything runs as root.
4. **Lines outside the managed section are sacred.** Unrelated content must stay byte-for-byte identical, including CRLF line endings and a missing final newline. Removing the last site must restore the original file exactly. `test/hosts.test.ts` asserts all of this.
5. **Refuse rather than guess.** If the section is malformed (duplicate or missing markers, lines focus didn't write, invalid hostnames), throw `HostsFormatError` and change nothing. The "Manual recovery" sections in the README and the guide are the escape hatch, so keep both accurate whenever the marker format changes. The error message points to the README's heading, so don't rename it.
6. **The hosts file is the only state** for hosts-file blocking. The block list and on/off state live inside the section. Don't add a database or state file, and don't copy the list into the config file. The exceptions are the Chrome extension's settings, the subreddit allowlist and the feeds file (see the design decisions); they never hold hosts-file state.

## Layout

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Argument parsing (`node:util` `parseArgs` with `allowNegative`), command dispatch, output, and the `Io` interface tests inject. It also holds the real dependencies used in `import.meta.main`: DNS flush, the `gh` token lookup, and running the new binary during an upgrade. |
| `src/hosts.ts` | Pure functions. `readSection` and `writeSection` parse and replace the section, and `renderSection` produces the exact text. A section is `{ state, presets: [{ id, hosts }], sites }`. It knows nothing about the preset catalog: it reads groups exactly as written and flags 0.1.0 sections, which have no group headers, as `legacy`. |
| `src/hostsfile.ts` | File I/O. `readHostsFile` resolves symlinks. `writeHostsFile` writes the backup, checks for concurrent changes, then calls `writeAtomically`. `writeAtomically` writes a temp file with the same mode and owner, fsyncs, runs an optional `verify`, then renames. The upgrade also uses it. |
| `src/hostname.ts` | `normalizeHostname`: lowercases, converts to punycode, rejects URLs (and suggests the hostname), IP addresses, wildcards, single labels and local suffixes. |
| `src/diff.ts` | Unified diff for `--dry-run`. Its output is byte-identical to `diff -u` and applies cleanly with `patch`. |
| `src/config.ts` | Optional `~/.config/focus/config.json` holding the `exact` and `flushDns` defaults. Under sudo, `~` is the invoking user's home, found with `dscl`. Unknown keys are errors. |
| `src/presets.ts` | The preset catalog, with exact hostnames for each preset. It also contains four functions, plus a 0.1.0 hostname table used only for the one-time conversion:<br>• `syncSection` rebuilds every group from the catalog and converts legacy sections.<br>• `withPresets` sets exactly the given presets.<br>• `presetBlocking` finds which enabled preset owns a host.<br>• `suggestPresets` finds the preset a mistyped name probably meant. |
| `src/prompt.ts` | The `@clack/prompts` grouped checklist for `config` and `init`, and a text prompt (subreddits). Kept separate so the CLI logic can be tested with stubs (`choose`, `askText` on `Io`). |
| `src/sudo.ts` | `setup-sudo` itself. It covers the rule text (strict username and path patterns, so nothing needs sudoers escaping) and `checkBinaryIsSafe` (the binary and every parent directory must be owned by root and not group- or other-writable). Installing validates the temp file with `visudo` before renaming it into place, then verifies the result with `sudo -l -U`. |
| `src/upgrade.ts` | Self-update against the GitHub releases API. Network, token, binary path and the "run the new binary" step are all injected. |
| `src/version.ts` | `VERSION` imported from `package.json`, which is the single source of truth. |
| `src/feeds.ts` | `FEED_SITES` (YouTube and X, each with the preset that blocks it whole) and the feeds file, `~/.config/focus/feeds.json` (`{ "version": 1, "feeds": [...] }`), read and written in catalog order. |
| `src/subreddits.ts` | The subreddit allowlist, `~/.config/focus/subreddits.json` (`{ "version": 1, "allow": [...] }`). `normalizeSubreddit` accepts names, `r/name` and Reddit URLs, and rejects feeds (`all`, `popular`, …) and multireddits. At most 500 names. |
| `src/chrome.ts` | Installing the extension: `writeExtension` copies `EXTENSION_FILES` into a staging folder, stamps `version`/`version_name`, then swaps it into place. `writeNativeHostManifest` registers the binary with Chrome for the extension's id, which `extensionId` derives from the manifest `key`. `findLoadedExtension` reads each Chrome profile's `Secure Preferences` to see whether the extension is loaded from that folder and allowed in Incognito. |
| `src/terminal.ts` | Terminal niceties for output: OSC 8 links (only in terminals known to support them, overridable with `FORCE_HYPERLINK`), styles and the spinner. No dependency. |
| `src/nativehost.ts` | focus as the extension's native-messaging host: little-endian length-prefixed JSON on stdin/stdout, one request and one reply. `respond` reads the system hosts file's state and the allowlist, and refreshes an installed extension whose `version_name` differs. |
| `extension/` | The Chrome MV3 extension, plain JavaScript checked by `extension/tsconfig.json`. `rules.js` is pure (bun tests import it): `buildRules` turns the policy into declarativeNetRequest rules, `evaluate` predicts what Chrome does with them, and `mayStay` decides whether a page may stay given the subreddit it reported. `background.js` syncs with focus and enforces navigation; `comments.js` reports a post page's canonical subreddit; `blocked.html`/`blocked.js` explain a block. The build embeds the folder with `--asset ./extension`. |
| `scripts/build-release.ts` | Compiles, signs, smoke-tests `--version`, and writes `SHA256SUMS`. |
| `docs/images/` | README images, light and dark, exported at 2x from the Paper file "Patient umbrella", page "README — focus images". The terminal ones (`init`, `session`, `chrome`) are designed mockups of real output, so re-export them when the `config`/`init` checklist, `status`, the diff or the Chrome commands' output changes. `blocked` frames a real screenshot of `blocked.html`, taken in Chrome for Testing at 2x for each color scheme; retake it when the blocked page changes. |
| `install.sh` | The POSIX sh installer. It uses `gh release download` when `gh` is authenticated, otherwise public URLs. |

## Design decisions (don't undo these without asking)

- **Marker format** is exactly `# BEGIN focus` … `# END focus`. Inside are a `# state: on|off` line and `# preset: <id>` / `# sites` group headers. Older binaries treat the group headers as ordinary comments, so a 0.1.0 binary can still read a newer file. Each host gets two lines: `0.0.0.0 <host>` and `:: <host>`. `off` comments them out as `# 0.0.0.0 <host>`. The `sed` recovery command in the README and the guide depends on these markers.
- **`www.` expansion:** `add` and `remove` include the `www.` variant unless you pass `--exact` or the config sets `"exact": true`. Presets list exact hostnames and ignore the expansion.
- **Presets are recorded, not just expanded.** The section groups hosts under `# preset: <id>` and `# sites`.
  - **Syncing:** every command starts from `syncSection(readSection(...))`, so any write brings presets up to date with the running version's catalog. `focus sync` does only that, and `focus upgrade` runs the new binary's `sync` after swapping it in.
  - **Status:** `status` reports `Sync: needed` when the synced section would render differently from what's on disk.
  - **Removed presets:** if a preset disappears from the catalog, its hosts are kept as sites. They're never silently unblocked.
  - **Adding, removing, renaming:** adding or removing hosts in a preset is a normal change. Renaming a preset id isn't; files on disk would treat the old id as unknown and demote its hosts to sites.
- **0.1.0 conversion:** a legacy section adopts any preset whose current or 0.1.0 hostnames are all present. If you change a preset's hostnames, `V0_1_0_HOSTS` must keep its 0.1.0 list, so 0.1.0 files still convert. Only presets that changed since 0.1.0 need an entry. Never add newer lists to that table.
- **`config` and `init` are one checklist,** run as the user, before any sudo. It has whole-site presets and the Chrome options; it starts from what's set (a first `init`: the recommended presets), and the selection replaces it. Chrome settings are written as the user; the hosts change runs `init <ids>` (or `remove <all>` for none) through `runCommand`, so through sudo. As root, only presets are offered. Named presets (`init x youtube`) and `--yes` skip the checklist.
- **Presets are all or nothing.** `remove <host>` refuses hosts owned by an enabled preset and points to `remove <id>`. Per-host exceptions aren't supported.
- **A single word is a preset.** `normalizeHostname` rejects single labels, so `add`/`remove` read any argument that `findPreset` knows as a preset and anything else as a hostname. An unknown single word is a usage error; `suggestPresets` offers the likely preset (typos, name words such as `twitter`, prefixes of 3+ letters) but never applies it.
- **Messenger is separate.** It's its own preset, unchecked by default, and must never be folded into Facebook; the user relies on it. Shared CDNs (`fbcdn.net`, `ytimg.com`, `googlevideo.com`, `redditmedia.com`) are never blocked.
- **The config file can't set the hosts file path.** The config is writable by the user but read by a root process, so it could aim focus, running as root, at other system files such as `/etc/sudoers`. Use `--hosts-file` or `FOCUS_HOSTS_FILE` instead.
- **Getting root.** `/etc/hosts` must stay root-owned and mode 644. Never make it user-writable or make focus setuid.
  - **Re-running through sudo:** when focus isn't root, any command that changes the system hosts file (`MUTATING_COMMANDS`, unless `--dry-run`) re-runs itself with `/usr/bin/sudo <realpath of binary> <argv>`. It runs the real path because that's the path the sudoers rule names.
  - **`upgrade`** first checks for a newer release as the user. It asks sudo only if there's something to install and the binary's directory isn't writable.
  - **`setup-sudo`** installs a NOPASSWD rule for exactly that binary.
- **What root may do.** Passwordless sudo means anything running as the user can run focus as root, so root mode has three limits:
  - It only manages `systemHostsFile`; `--hosts-file` and `FOCUS_HOSTS_FILE` are refused unless they point at it.
  - It reads the config only if the file is owned by `SUDO_UID`.
  - `setup-sudo` refuses to run from source and refuses an unsafe binary.

  Keep all three when adding commands or flags. A new flag that names a path or URL is a privilege-escalation risk.
- **The Chrome extension is a separate component.** Hosts-file code doesn't know about it. Each site has its own setting: feeds only for YouTube and X and messages only for Instagram (`feeds.json`), and Reddit limited to an allowlist (`subreddits.json`; Reddit is limited only while that file exists and isn't switched off with `"enabled": false`, which `config` writes so the list survives).
  - **On/off comes from the hosts file.** The native host only reads the section's `state`; there's no second switch. A missing section means `none`, which doesn't enforce.
  - **The allowlist and the feeds are the extension's own state.** They're at fixed user paths with no environment override, because Chrome starts the host without the shell's environment. They're never in `config.json` or the hosts file, and root never reads them: `reddit`, `feeds`, `chrome` and the native host refuse root, and `status` skips them as root.
  - **The native host is one-shot and read-only.** Chrome starts it per message; it reads `systemHostsFile` (never `--hosts-file` or `FOCUS_HOSTS_FILE`), the allowlist and the feeds, and nothing else may be written to stdout. Its only write is refreshing the installed extension folder after an upgrade. Don't turn it into a long-running process.
  - **Rules block pages only** (`main_frame`, `sub_frame`) with the `block` action, never scripts, media or API calls, so the sites' own changes don't break what's allowed. All rules are dynamic, so off is an empty rule set. Each site has its own range of rule ids (Reddit 1-9 and 100 up, YouTube 20-29, X 30-39, Instagram 40-49). Instagram's rule is a `redirect` to the inbox, not a block, and `enforce` sends its tabs to the inbox in any window. YouTube's recommendations are hidden by `youtube.css`, scoped to an attribute `youtube.js` sets from the cached policy, so it follows focus on and off without a reload. One allow rule per subreddit keeps each regex small; Chrome allows 1,000 regex rules.
  - **Posts are judged by their canonical subreddit.** Bare `/comments/<id>` and `/gallery/<id>` pages are allowed by the rules so `comments.js` can report the subreddit the page's canonical link names; `mayStay` then decides, for `/r/<name>/comments/<id>` too. Reports are kept per tab in `chrome.storage.session`, so sweeps after a policy change still know which post a tab shows. A bare post with no report (a client-side route, or a tab older than the extension) is reloaded once so it reports.
  - **Incognito can't show extension pages** (the extension is `spanning`), so `enforce` sends Incognito tabs to a URL the rules block (`BLOCKED_PAGES` for the site), never to a URL they allow, which would reload forever.
  - **`enforce` only acts while the tab still shows the URL it judged** (`stillOn`). Decisions can wait on a refresh from focus, and by then the tab may have moved on.
  - **The extension installs rules before updating its cached policy,** so the cache is never ahead of what Chrome enforces. Each service worker first reinstalls the cached rules inside the serialized `refresh()` queue, so they can't land after newer ones. Navigation checks decide from the cache.
  - **A broken allowlist isn't an error state.** The native host reports it as `allowlistError` with `allow: []` and the real on/off state, so off always means off. Only an unreadable hosts file makes the extension keep its last rules.
  - **A preset that blocks a site whole makes its Chrome setting do nothing.** `feeds add` and `reddit allow` offer to remove it: in a terminal, Enter runs `focus remove <preset>` through `runCommand` (so through sudo, as any hosts change is); otherwise they print the command. `status` notes the conflict. focus never removes a preset without that Enter.
  - **The extension id is pinned** by the `key` in `extension/manifest.json` (`ppkaiojneebcgfinkmccagdflccineob`). The private key was never kept; it's only needed to pack a CRX. Changing the key changes the id and breaks every installed host manifest.
- **`chrome install` drives Chrome from outside, and asks first.** Each step is explained, then Enter opens what it needs (Esc skips, Ctrl-C exits 130 via `Interrupted`); without a terminal it only prints. It opens `chrome://extensions` with `open -a "Google Chrome"` (Chrome ignores `chrome://` URLs as arguments and doesn't register the scheme, so they can't be terminal links), reveals the folder in Finder for dragging, copies its path, then polls `findLoadedExtension` until each step lands. Chrome saves profile prefs about 10 seconds after a change. focus only ever reads Chrome's profile files.
- **DNS is flushed only after writing the real `/etc/hosts`.** The check compares against `realpath("/etc/hosts")`. Any other path never triggers `dscacheutil` or `killall`.
- **Writes are atomic and keep mode, uid and gid.** Extended attributes and ACLs are not kept. That trade-off is documented in the guide.

## macOS, Bun and GitHub gotchas

- **Re-sign compiled binaries.** `bun build --compile` leaves an invalid ad-hoc signature, and macOS SIGKILLs the binary (exit 137). Always run `codesign --sign - --force <binary>` afterwards. The `build` scripts already do.
- **arm64 only.** Intel builds can be cross-compiled but can't be run anywhere, including GitHub's macOS runners, and macOS 27 is Apple silicon only. `install.sh` and `upgrade` both refuse other architectures.
- **Detecting the compiled binary:** `Bun.main` starts with `/$bunfs/`, and `process.execPath` is then the binary's path. From source, `upgrade` refuses to replace anything.
- **sudo:** commands that write run as root, which affects two things. Config paths and the `gh` token are resolved for `SUDO_USER` (`dscl` lookup; `sudo -u $SUDO_USER -i gh auth token`).
  - **Tested:** visudo validation runs for real in `test/sudo.test.ts`. Elevation was checked up to sudo's prompt, with no cached login, so sudo refused before running anything.
  - **Not tested:** the `dscl` and `gh` lookups as the invoking user, and `setup-sudo` end to end. Agents can't use real sudo.
  - **macOS sudoers:** `/etc/sudoers` includes `/private/etc/sudoers.d`, and sudo ignores files there whose names contain a dot. That's why the temp file `.focus.focus-<pid>.tmp` is never read as a rule.
- **GitHub auth:**
  - Release downloads need auth. `upgrade` gets a token from `GITHUB_TOKEN`/`GH_TOKEN` or `gh auth token`, and sends it only to `api.github.com`.
  - Asset downloads use `redirect: "manual"` and follow the storage redirect without the `Authorization` header, because the storage service rejects requests that carry it.
  - The repo is public, so the README's `curl | sh` one-liner and unauthenticated release downloads work. `install.sh` still prefers `gh` when it's logged in.
- **Interactive testing:** `init` needs a TTY. To drive it in a pseudo-terminal, use `script -q log sh -c 'stty cols 100 rows 40; bun src/cli.ts init'` and pipe keystrokes in with `sleep`s between them. Without `stty`, the terminal has zero columns and clack wraps every character onto its own line.
- **Testing the extension in Chrome:** `bun test` covers the rules, the native host and the CLI. `test/background.test.ts` also runs `background.js` against a stand-in `chrome` object, importing a fresh copy per test (`background.js?worker=<n>`) the way a service worker starts; add any new `chrome.*` API it uses to the stand-in. None of that is Chrome itself. Branded Chrome ignores `--load-extension`, so use Chrome for Testing (`bunx @puppeteer/browsers install chrome@stable`) with a temporary `--user-data-dir`, `--load-extension`, and `--host-resolver-rules` mapping the Reddit hosts to a local `Bun.serve`. Serve it over HTTPS with a self-signed certificate and `--ignore-certificate-errors`, because reddit.com is HSTS-preloaded. Chrome looks for native-messaging host manifests in `<user-data-dir>/NativeMessagingHosts`, so the real Chrome setup is never touched. Reloading an extension loaded this way disables it (`unsupportedDeveloperExtension`) unless Developer mode is on; turn it on with `chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })` from a `chrome://extensions` page (writing the Preferences file doesn't work). The host there should call `respond` with a temp hosts file, because the binary's host always reads `/etc/hosts`.
- **CI:** runs on `macos-latest`. That's free for public repos; if the repo goes private again, macOS minutes count 10 times faster than Linux.

## Releasing

Bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` then:
1. runs the typecheck and tests;
2. fails if the tag doesn't equal `v` + the `package.json` version;
3. runs `build:release`;
4. publishes `focus-darwin-arm64`, `SHA256SUMS` and `install.sh` with `gh release create`.

The asset names are used in three places: `src/upgrade.ts` (`ASSET` and `CHECKSUMS`), `install.sh`, and the workflow. Change them in all three together.
