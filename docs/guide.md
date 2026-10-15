# focus guide

The full reference for focus. For a quick start, see the [README](../README.md).

## Install

focus ships as a single self-contained binary for Apple silicon, with the Bun runtime built in. The installer downloads the latest release, checks its SHA-256 and that it runs, then installs it to `/usr/local/bin/focus`. It asks for sudo only if that directory isn't writable.

```bash
curl -fsSL https://raw.githubusercontent.com/brentvatne/focus/main/install.sh | sh
```

If the GitHub CLI is installed and logged in, the installer downloads through it instead of plain `curl`.

Set `FOCUS_VERSION=v0.1.0` to install a specific release, or `FOCUS_INSTALL_DIR` to install somewhere else.

### Upgrading

```bash
focus upgrade -n        # check for a newer release
focus upgrade           # replace /usr/local/bin/focus with it, then sync presets
```

`focus upgrade` downloads the latest release and checks its SHA-256 against `SHA256SUMS`. It then runs the new binary's `--version` and swaps it in atomically, keeping the file's mode and owner. If any step fails, the installed binary is left untouched.

After swapping, the new binary runs `focus sync`, so your presets pick up any hostnames the new version added (see [Presets](#presets-focus-init)). Upgrades made with 0.1.0's `upgrade` command, or by re-running `install.sh`, skip this step. In that case `focus status` says a sync is needed; run `focus sync`.

focus doesn't need a GitHub token to upgrade. If you have one, it's used to avoid API rate limits. focus looks in this order:

1. `GITHUB_TOKEN` or `GH_TOKEN`
2. `gh auth token`. Under sudo, this runs as the user who invoked sudo, because root has no `gh` login.

The token is sent only to `api.github.com`, never to the storage URL that GitHub redirects downloads to.

### From source

```bash
bun install
bun run build                                      # compiles and ad-hoc signs dist/focus
sudo install -m 755 dist/focus /usr/local/bin/focus
```

The build step re-signs the binary because macOS kills Bun's compiled output (exit 137) without a valid signature. To run without compiling, give sudo the full path to bun: `sudo "$(which bun)" src/cli.ts status`.

## Usage

```bash
focus init                         # choose preset site groups from a checklist (see below)
focus add --preset instagram       # turn one preset on…
focus remove --preset instagram    # …or off
focus add example.com              # also blocks www.example.com
focus add --exact news.example.com
focus remove example.com           # also removes www.example.com unless --exact
focus off                          # stop blocking but keep the list
focus on                           # start blocking again
focus sync                         # update presets to this version's hostnames
focus status                            # read-only
```

Commands that change `/etc/hosts` need root, so focus re-runs itself through `sudo` and you get a password prompt. To skip the prompt, see [Running without a password](#running-without-a-password). `status`, `--dry-run` and `version` never ask.

Add `-n` / `--dry-run` to any command to print a unified diff of the hosts file without writing it:

```bash
focus add -n twitter.com
```

| Option | Meaning |
| --- | --- |
| `-y`, `--yes` | `init` only: keep the current presets without prompting (on a fresh install, use the recommended ones) |
| `--preset` | `add`/`remove` only: the arguments are preset names, not hostnames |
| `-n`, `--dry-run` | Print the diff and don't write anything |
| `--exact` / `--no-exact` | Don't (or do) add or remove the `www.` variant. The default comes from the config file, or is `--no-exact`. |
| `--hosts-file <path>` | Manage a different file. You can also set `FOCUS_HOSTS_FILE`. The default is `/etc/hosts`. |
| `--flush` / `--no-flush` | Do (or don't) flush the DNS cache after writing. The default comes from the config file, or is `--flush`. |

## Presets: `focus init`

`focus init` opens a checklist of common distractions. Your current presets start checked; on a fresh install, the recommended ones are. The final selection replaces your presets, so unchecking one turns it off:

```
◆  Which sites should focus block?
│  ◼ X / Twitter
│  ◼ Facebook (doesn't include Messenger)
│  ◼ YouTube
│  ◼ Reddit (the whole site, every subreddit included)
│  ◻ Instagram
│  ...
│  ◻ Messenger
│  ↑/↓ to navigate • Space: select • Enter: confirm
```

| Preset | Recommended | Hostnames |
| --- | --- | --- |
| `x` | yes | x.com, www.x.com, mobile.x.com, api.x.com, twitter.com, www.twitter.com, mobile.twitter.com, api.twitter.com |
| `facebook` | yes | facebook.com, www.facebook.com, m.facebook.com, web.facebook.com, fb.com, www.fb.com |
| `youtube` | yes | youtube.com, www.youtube.com, m.youtube.com, youtu.be |
| `reddit` | yes | reddit.com, www.reddit.com, old.reddit.com, new.reddit.com, m.reddit.com, redd.it |
| `instagram` | no | instagram.com, www.instagram.com |
| `tiktok` | no | tiktok.com, www.tiktok.com, m.tiktok.com |
| `linkedin` | no | linkedin.com, www.linkedin.com |
| `hackernews` | no | news.ycombinator.com |
| `messenger` | no | messenger.com, www.messenger.com |

- **Messenger is separate from Facebook,** so you can block Facebook and still use messenger.com. Shared CDNs such as `fbcdn.net`, `ytimg.com` and `googlevideo.com` are never blocked, which keeps embeds and Messenger's assets loading. `music.youtube.com` also stays reachable.
- **Presets add exact hostnames.** The `www.` expansion and `exact` don't apply to them.
- **Presets follow new versions.** focus records which presets you chose (`# preset: <name>` in the hosts file) rather than just copying their hostnames. Whenever it writes the file, it rebuilds each preset from the running version's list. So when a preset gains a hostname, as X did with `api.x.com`, you get it after `focus upgrade` or any other change. Hostnames a preset drops are removed the same way. Sites you added yourself are never touched.
- **One preset is all or nothing.** `focus remove api.x.com` refuses and points you to `focus remove --preset x`. Adding a hostname that a preset already covers is a no-op.
- **Without a prompt:** `focus init x youtube` sets your presets to exactly the named ones, and `focus init --yes` keeps the current ones (or picks the recommended ones on a fresh install). Use one of these in scripts; `init` with neither stops with an error when there's no terminal.
- **Upgrading from 0.1.0:** 0.1.0 didn't record presets. The first time a newer version writes the file, any preset whose 0.1.0 hostnames are all present is recorded as that preset; everything else is kept as your own sites.

## Running without a password

```bash
focus setup-sudo              # asks for your password one last time
focus setup-sudo -n           # show the rule without installing it
focus setup-sudo --remove     # undo
```

`setup-sudo` installs `/etc/sudoers.d/focus`:

```
brentvatne ALL=(root) NOPASSWD: /usr/local/bin/focus
```

After that, focus still gets root through sudo, just without the prompt.

The trade-off: any program running as you can also run focus as root without your password. That means it could run `focus off`. That's fine for a self-control tool, which doesn't defend against you anyway. These safeguards keep the rule from granting more than that:

- **Only the installed binary.** focus refuses to install the rule when running from source, because a rule naming `bun` would grant root for any script.
- **Only a binary nobody else can change.** The binary and every directory above it must be owned by root and not writable by group or others. `/usr/local/bin/focus` from `install.sh` qualifies. Otherwise, replacing the binary would be a way to become root.
- **As root, focus only ever writes `/etc/hosts`.** `--hosts-file` and `FOCUS_HOSTS_FILE` are refused unless they point at it, so the rule can't be used to write other root-owned files.
- **Under sudo, the config file must be yours.** Otherwise a config symlinked to a root-only file could leak bits of that file through error messages.
- **The rule is checked twice.** It's validated with `visudo -cf` before it's moved into place, so a syntax error can't break sudo. Afterwards, focus confirms with `sudo -l` that sudo picked it up, and removes the rule again if it didn't.
- **Upgrades keep it working,** because `focus upgrade` replaces the binary at the same path.

## Configuration

focus reads defaults from a global config file. This is optional; if the file doesn't exist, the built-in defaults apply. focus looks for the file in this order:

1. `$FOCUS_CONFIG`
2. `$XDG_CONFIG_HOME/focus/config.json`
3. `~/.config/focus/config.json`

Under `sudo`, `~` means the home directory of the user who ran sudo (looked up with `dscl`), not `/var/root`. That way focus reads the same file whether or not it's running under sudo. `focus status` prints the path it used.

```json
{
  "exact": true,
  "flushDns": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `exact` | `false` | Default for `--exact` |
| `flushDns` | `true` | Default for `--flush` |

Flags always win over the config file. focus rejects unknown keys and non-boolean values, so a typo can't be silently ignored.

Two things are deliberately left out of the config file:
- **The block list.** It lives only in the hosts file, which keeps one source of truth and keeps undoing simple.
- **The hosts file path.** The config file is writable by your user but read by a root process. If it could set the path, a bad entry could make focus, running as root, append lines to some other system file, such as `/etc/sudoers`. Use `--hosts-file` or `FOCUS_HOSTS_FILE` instead.

## How it works

focus owns only the lines between its two markers:

```
# BEGIN focus
# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.
# state: on
# preset: youtube
0.0.0.0 youtube.com
:: youtube.com
...
# sites
0.0.0.0 example.com
:: example.com
# END focus
```

Presets come first, each under its own `# preset:` header and in catalog order. Hostnames you added with `focus add` come under `# sites`.

- **IPv4 and IPv6:** each hostname points to both `0.0.0.0` and `::`. A site that has an AAAA record can't get through over IPv6.
- **on/off:** `off` comments out the entries, so the list stays in the file. The hosts file is the only place focus stores state, including which presets you chose.
- **Reversible:** when you remove the last site and preset, focus deletes the whole section, and the file is byte-for-byte what it was before. The one exception is a file that had no trailing newline: it gains one.
- **Hostname validation:** focus lowercases hostnames, removes a trailing dot and converts internationalized names to punycode. It rejects URLs (and suggests the hostname), IP addresses, wildcards, single-label names like `localhost`, and local suffixes such as `.local`, `.localhost` and `.arpa`.
- **Safe writes:** before every write, focus saves the previous file to `/etc/hosts.focus-backup`. It then writes the new contents to a temp file in `/private/etc` with the original mode, owner and group, fsyncs it and renames it into place, so the hosts file is never half-written. If something else changed the file in the meantime, focus aborts and writes nothing. Symlinks are resolved, so `/etc` → `/private/etc` stays a symlink.
- **Malformed section:** if the section has a missing or duplicate marker, or a line focus didn't write, focus refuses to make any change until you fix it by hand (see below).
- **DNS cache:** after it writes the real `/etc/hosts`, focus runs `dscacheutil -flushcache` and `killall -HUP mDNSResponder`. It never does this for any other file.

### Limitations

- `/etc/hosts` has no wildcards. Blocking `youtube.com` doesn't block `m.youtube.com`, so add each subdomain you care about.
- Browsers cache DNS and keep connections open. If a site still loads, restart the browser. In Chrome you can also use `chrome://net-internals/#dns` → *Clear host cache*.
- Browsers that use DNS-over-HTTPS in a strict mode (such as Firefox's "Max Protection"), VPNs and proxies can bypass `/etc/hosts`.
- The rename replaces the file. It keeps mode and ownership but not extended attributes or ACLs.

## Follow-ups

These are deliberately out of scope for v1.

- **Allow certain subreddits and block the rest of Reddit.** This can't be done with `/etc/hosts`. Every subreddit is a path on the same hostname (`reddit.com/r/...`), and the hosts file only sees hostnames. Over HTTPS, nothing outside the browser can see the path without intercepting TLS. The realistic options are:
  - **A browser extension (preferred).** It can use Chrome's `declarativeNetRequest` or Firefox's `webRequest` to block `*://*.reddit.com/*` but allow `/r/<name>/*` on `www`, `old` and `new.reddit.com`. Rules would have to cover subreddit assets, the API calls new Reddit makes, and redirects from `/` and `/r/all`.
  - **A local proxy that intercepts TLS.** It works across browsers, but it needs a trusted root certificate, which makes it heavier and riskier.

  Either one is a separate component from the hosts file. focus could manage it later, for example with `focus reddit allow <subreddit>`.

## Manual recovery

Use these steps if focus is broken or uninstalled, or if it reports a malformed section.

1. **Try the CLI first.** `focus off` stops blocking. Unchecking everything in `focus init` and removing your own sites with `focus remove <host...>` deletes the section completely. If focus itself is broken, use `sudo /usr/local/bin/focus off`, or carry on below.

2. **Delete the section by hand.** Make a copy first, then delete everything from `# BEGIN focus` to `# END focus`:

   ```bash
   sudo cp /etc/hosts /etc/hosts.before-recovery
   sudo sed -i '' '/^# BEGIN focus$/,/^# END focus$/d' /etc/hosts
   ```

   You can also edit the file with `sudo nano /etc/hosts`, delete those lines and save.

3. **Or restore the backup.** `/etc/hosts.focus-backup` holds the file as it was before focus's most recent write:

   ```bash
   sudo cp /etc/hosts.focus-backup /etc/hosts
   ```

4. **Last resort: restore the macOS default.** This discards any custom entries you had:

   ```bash
   printf '##\n# Host Database\n#\n# localhost is used to configure the loopback interface\n# when the system is booting.  Do not change this entry.\n##\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n' | sudo tee /etc/hosts >/dev/null
   ```

5. **Check ownership and permissions.** The file should be `-rw-r--r--  root  wheel`:

   ```bash
   ls -l /private/etc/hosts
   sudo chown root:wheel /private/etc/hosts && sudo chmod 644 /private/etc/hosts
   ```

6. **Remove the sudoers rule,** if you installed one and are uninstalling focus: `sudo rm /etc/sudoers.d/focus`.

7. **Flush DNS and verify:**

   ```bash
   sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
   grep -n focus /etc/hosts                     # should print nothing
   dscacheutil -q host -a name youtube.com      # should show real addresses, not 0.0.0.0
   ```

## Development

```bash
bun test            # unit and CLI tests on temp files only, never /etc/hosts
bun run typecheck
```

The tests always set `FOCUS_HOSTS_FILE` and `FOCUS_CONFIG` to files in a fresh temp directory and replace the DNS flush with a stub. This means a test can never reach `/etc/hosts` or your real config file.

`src/` contains:

- `hostname.ts`: validation and normalization
- `config.ts`: locating and validating the config file
- `hosts.ts`: parsing and rendering the managed section (pure functions)
- `diff.ts`: unified diff for `--dry-run`
- `hostsfile.ts`: reading and writing the file safely
- `presets.ts` and `prompt.ts`: the `init` presets and checklist
- `upgrade.ts` and `version.ts`: self-update
- `sudo.ts`: the `setup-sudo` rule and its safety checks
- `cli.ts`: commands

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The Release workflow runs the tests and checks that the tag matches `package.json`. It then builds and signs `focus-darwin-arm64` (`bun run build:release`) and publishes it with `SHA256SUMS` and `install.sh` as a GitHub release. Installed copies pick it up with `focus upgrade`.
