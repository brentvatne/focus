# focus

A small macOS CLI that blocks distracting websites by managing one marked section of `/etc/hosts`. Everything else in the file is left exactly as it is, and every change can be undone.

## Install

focus ships as a single self-contained binary for Apple silicon, with the Bun runtime built in. The installer downloads the latest release, checks its SHA-256 and that it runs, then installs it to `/usr/local/bin/focus`. It asks for sudo only if that directory isn't writable.

While the repo is private, install through the GitHub CLI, logged in with `gh auth login`:

```bash
gh release download -R brentvatne/focus -p install.sh -O - | sh
```

Once the repo is public, this works too:

```bash
curl -fsSL https://raw.githubusercontent.com/brentvatne/focus/main/install.sh | sh
```

Set `FOCUS_VERSION=v0.1.0` to install a specific release, or `FOCUS_INSTALL_DIR` to install somewhere else.

### Upgrading

```bash
focus upgrade -n        # check for a newer release
sudo focus upgrade      # replace /usr/local/bin/focus with it
```

`focus upgrade` downloads the latest release and checks its SHA-256 against `SHA256SUMS`. It then runs the new binary's `--version` and swaps it in atomically, keeping the file's mode and owner. If any step fails, the installed binary is left untouched.

For a private repo, focus finds a token in this order:

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
sudo focus init                         # pick from preset site groups (see below)
sudo focus add youtube.com reddit.com   # also blocks www.youtube.com and www.reddit.com
sudo focus add --exact news.ycombinator.com
sudo focus off                          # stop blocking but keep the list
sudo focus on                           # start blocking again
sudo focus remove reddit.com            # also removes www.reddit.com unless --exact
focus status                            # read-only, so no sudo needed
```

Add `-n` / `--dry-run` to any command to print a unified diff of the hosts file without writing it:

```bash
focus add -n twitter.com
```

| Option | Meaning |
| --- | --- |
| `-y`, `--yes` | `init` only: add the recommended presets without prompting |
| `-n`, `--dry-run` | Print the diff and don't write anything |
| `--exact` / `--no-exact` | Don't (or do) add or remove the `www.` variant. The default comes from the config file, or is `--no-exact`. |
| `--hosts-file <path>` | Manage a different file. You can also set `FOCUS_HOSTS_FILE`. The default is `/etc/hosts`. |
| `--flush` / `--no-flush` | Do (or don't) flush the DNS cache after writing. The default comes from the config file, or is `--flush`. |

## Presets: `focus init`

`focus init` opens a checklist of common distractions, with the recommended presets already checked:

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
| `x` | yes | x.com, www.x.com, mobile.x.com, twitter.com, www.twitter.com, mobile.twitter.com |
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
- **`init` only adds sites.** Running it again shows presets you've already blocked as disabled. To unblock one, use `focus remove --exact <host...>`.
- **Without a prompt:** `focus init x youtube` adds the named presets, and `focus init --yes` adds the recommended ones. Use one of these in scripts; `init` with neither stops with an error when there's no terminal.

## Configuration

focus reads defaults from a global config file. This is optional; if the file doesn't exist, the built-in defaults apply. focus looks for the file in this order:

1. `$FOCUS_CONFIG`
2. `$XDG_CONFIG_HOME/focus/config.json`
3. `~/.config/focus/config.json`

Under `sudo`, `~` means the home directory of the user who ran sudo (looked up with `dscl`), not `/var/root`. That way `sudo focus` and `focus` read the same file. `focus status` prints the path it used.

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
- **The hosts file path.** The config file is writable by your user but read by a root process. If it could set the path, a bad entry could make `sudo focus` append lines to some other system file, such as `/etc/sudoers`. Use `--hosts-file` or `FOCUS_HOSTS_FILE` instead.

## How it works

focus owns only the lines between its two markers:

```
# BEGIN focus
# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.
# state: on
0.0.0.0 youtube.com
:: youtube.com
# END focus
```

- **IPv4 and IPv6:** each hostname points to both `0.0.0.0` and `::`. A site that has an AAAA record can't get through over IPv6.
- **on/off:** `off` comments out the entries, so the list stays in the file. The hosts file is the only place focus stores state.
- **Reversible:** when you remove the last site, focus deletes the whole section, and the file is byte-for-byte what it was before. The one exception is a file that had no trailing newline: it gains one.
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

1. **Try the CLI first.** `sudo focus off` stops blocking. Removing every site with `sudo focus remove <host...>` deletes the section completely.

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

6. **Flush DNS and verify:**

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
- `cli.ts`: commands

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The Release workflow runs the tests and checks that the tag matches `package.json`. It then builds and signs `focus-darwin-arm64` (`bun run build:release`) and publishes it with `SHA256SUMS` and `install.sh` as a GitHub release. Installed copies pick it up with `sudo focus upgrade`.
