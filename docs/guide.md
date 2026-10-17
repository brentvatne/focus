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

After swapping, the new binary runs `focus sync`, so your presets pick up any hostnames the new version added, and brings the Chrome extension's files up to date if you use it (see [Choosing what to block](#choosing-what-to-block-focus-init-and-focus-config)). Upgrades made with 0.1.0's `upgrade` command, or by re-running `install.sh`, skip this step. In that case `focus status` says a sync is needed; run `focus sync`.

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
focus init                         # set up: choose what to block, one row per site (see below)
focus config                       # change it later: the same list, starting from what's set
focus add instagram                # turn one preset on…
focus remove instagram             # …or off
focus add example.com              # also blocks www.example.com
focus add --exact news.example.com
focus remove example.com           # also removes www.example.com unless --exact
focus off                          # stop blocking but keep the list
focus on                           # start blocking again
focus                              # toggle: off if it's on, on if it's off
focus feeds add youtube            # in Chrome, block only YouTube's feed (see "Finer blocking in Chrome")
focus reddit allow rust            # in Chrome, block Reddit except this subreddit
focus sync                         # update presets to this version's hostnames
focus status                       # read-only
focus stats                        # how long focus was on, and what Chrome tried to open (see "Stats")
```

Commands that change `/etc/hosts` need root, so focus re-runs itself through `sudo` and you get a password prompt. To skip the prompt, see [Running without a password](#running-without-a-password). `status`, `stats`, `--dry-run` and `version` never ask.

Add `-n` / `--dry-run` to any command to print a unified diff of the hosts file without writing it:

```bash
focus add -n twitter.com
```

| Option | Meaning |
| --- | --- |
| `-y`, `--yes` | `init` only: keep the current presets without prompting (on a fresh install, use the recommended ones) |
| `--preset` | `add`/`remove` only: treat every argument as a preset name. Rarely needed, because a single word already means a preset. |
| `-n`, `--dry-run` | Print the diff and don't write anything |
| `--exact` / `--no-exact` | Don't (or do) add or remove the `www.` variant. The default comes from the config file, or is `--no-exact`. |
| `--hosts-file <path>` | Manage a different file. You can also set `FOCUS_HOSTS_FILE`. The default is `/etc/hosts`. |
| `--days <n>` | `stats` only: how many days to show, today included (default 7, at most 366) |
| `--flush` / `--no-flush` | Do (or don't) flush the DNS cache after writing. The default comes from the config file, or is `--flush`. |

## Choosing what to block: `focus init` and `focus config`

`focus config` lists every site focus knows, one row each, set to what's set now. Each row is off, the whole site (blocked everywhere, through `/etc/hosts`), or for some sites just part of it in Chrome (see [Finer blocking in Chrome](#finer-blocking-in-chrome)). Your own sites are listed too, and the last row adds one. `focus init` is the same list for your first run: it starts from the recommended presets, then tells you what's next.

```
◆  What should focus block?
│  focus is on
│
│ › X / Twitter  ○ 1 off  ● whole site  ○ 3 feed only
│                Blocked everywhere, through /etc/hosts.
│                x.com · mobile.x.com · api.x.com · twitter.com …
│   Facebook     ○ off  ● whole site
│   YouTube      ○ off  ○ whole site  ● feed only
│   Reddit       ○ off  ● whole site  ○ chosen subreddits
│   Instagram    ● off  ○ whole site  ○ messages only
│   ...
│   example.com  ○ off  ● blocked
│   + Add a site…
│
└  ↑/↓ site · ←/→ or 1-3 mode · Enter: done · Esc: cancel
```

- **Keys:** ↑/↓ moves between sites; ←/→ changes the mode and stops at either end, so holding it can't overshoot; 1, 2 and 3 pick a mode directly; Space cycles. The row with the cursor says what its mode does and which hostnames it covers. Enter finishes; on the last row it adds a site. Esc cancels.
- **Nothing is written until you're done.** Then focus changes the hosts file first (asking sudo, as usual) and writes the Chrome settings only if that worked, so cancelling the password prompt leaves everything as it was. You get one line per site you changed.
- **It runs as you.** The list and the Chrome settings (which are your files) need no password. Run as root, it offers only off and whole site.
- **Chrome options:** turning one on offers to set up the extension (`focus chrome install`) if Chrome hasn't loaded it. Choosing "chosen subreddits" asks which ones, unless you already have a list; turning it off keeps the list for next time.
- **Both for one site:** if a site is blocked whole and also has its Chrome option set (from `focus feeds add`, say), its row shows the whole site and says the Chrome option is set too. Leaving the row as it is keeps both.
- **Screen readers:** with `ACCESSIBLE=1`, focus asks about one site at a time instead.
- **`--dry-run`** shows the hosts file diff and what would change in Chrome, and saves nothing.

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
- **One preset at a time:** `focus add instagram` and `focus remove instagram` turn a single preset on or off, and can be mixed with hostnames (`focus add tiktok example.com`). Hostnames always contain a dot, so a single word is always read as a preset. A word that isn't one is an error, with a suggestion when it looks like a typo or another name for one (`youtub` → `youtube`, `twitter` → `x`); nothing is changed.
- **One preset is all or nothing.** `focus remove api.x.com` refuses and points you to `focus remove x`. Adding a hostname that a preset already covers is a no-op.
- **Without a prompt:** `focus init x youtube` sets your presets to exactly the named ones, and `focus init --yes` keeps the current ones (or picks the recommended ones on a fresh install). Use one of these in scripts; `init` with neither, and `config`, stop with an error when there's no terminal.
- **Upgrading from 0.1.0:** 0.1.0 didn't record presets. The first time a newer version writes the file, any preset whose 0.1.0 hostnames are all present is recorded as that preset; everything else is kept as your own sites.

## Stats

```text
$ focus stats
focus is on, for 1h 15m (since 9:00 AM)

               On for   Sessions   Toggled   Blocked
Today          1h 15m          1         1         6
Yesterday      7h 25m          2         4        12
…
Total         38h 50m         11        21        54

Sessions: average 3h 31m, longest 4h 05m

Blocked most:
  YouTube        21
  Reddit         18
```

- **On for:** how long blocking was on each day. A session that runs past midnight counts toward both days.
- **Sessions** are counted on the day they start. **Toggled** is how many times focus was turned on or off that day. The average and longest are over sessions that have ended.
- **Blocked** counts each time Chrome tried to open a page focus blocks: a whole site blocked by the hosts file, or a feed, subreddit or Instagram page blocked by the extension. It needs the Chrome extension (`focus chrome install`), even if you only block whole sites. Other browsers and apps aren't counted. Pages Chrome loads ahead of time while you type, and tabs focus sends away because you just turned it on, don't count.
- **Where it's kept:** `~/.config/focus/stats.jsonl`, one line per event, written only as you (never as root). Delete it to start over. It holds times, on and off, and the hostnames that were blocked, never full URLs.
- **What's recorded when:** focus records turning blocking on or off when you run it as yourself (with or without a password prompt). A change made some other way (`sudo focus off`, or editing `/etc/hosts`) is noticed the next time you run focus; such sessions count toward time on, but not toward the average or longest. Stats start when you install a version with them; there's no history from before.

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

## Finer blocking in Chrome

Presets block a whole site. For some sites, the problem is just the feed: you want a video someone sent you, or a post, but not the endless stream around it. The hosts file can't tell those apart, because they share hostnames and `/etc/hosts` only sees hostnames. So focus comes with a Chrome extension that can, while focus is on:

- **Feeds only,** for YouTube and X: the feeds are blocked and direct links still work.
- **Messages only,** for Instagram: every other page goes to your inbox.
- **Chosen subreddits,** for Reddit: only the subreddits you allow load.

While focus is off, these sites are unrestricted, as with everything else. `focus on`, `focus off` and `focus` (toggle) control the extension too; there's nothing else to switch.

### Setting it up

```bash
focus chrome install                   # `focus reddit install` does the same
```

This writes the extension to `~/Library/Application Support/focus/chrome-extension`, registers focus with Chrome, and walks you through the two steps only Chrome can do. Each step is explained first; press Enter and `install` opens what you need, or Esc to skip it:

1. **Load it.** Enter opens `chrome://extensions` in Chrome, shows the folder in Finder and copies its path. Turn on **Developer mode** and drag the `chrome-extension` folder onto the page, or click **Load unpacked**, press ⌘⇧G, paste and press Return.
2. **Allow it in Incognito.** Once Chrome has loaded it, Enter opens the extension's details page; turn on **Allow in Incognito**. Skip this if you don't use Incognito.

After each step, `install` waits until Chrome has saved it, which takes up to about 10 seconds, and shows a ✓. Press Enter to stop waiting. If the extension is already loaded, `install` skips these steps, and `focus status` shows whether Chrome has it loaded and allowed in Incognito. Without a terminal, `install` only prints the steps and opens nothing.

### Blocking only feeds

```bash
focus feeds add youtube x instagram
focus feeds remove x                # stop blocking X's feed
focus feeds list
```

`focus config` has the same options, one row per site.

| Site | Blocked | Still works |
| --- | --- | --- |
| `youtube` | The home page, Shorts, Explore and Trending. On video pages, the recommended videos beside and after the video are hidden, and autoplay doesn't move on to one (it still plays the next video of a playlist). | Videos, `youtu.be` links, search, channels, playlists, your subscriptions and YouTube Music |
| `x` | The Home timeline, Explore and trends, search (including hashtags) and notifications | Posts and their replies, profiles, signing in |
| `instagram` | Every page but your messages: Instagram sends you to your inbox instead of showing a blocked page | Your inbox and conversations, signing in |

The `youtube` and `x` presets block these sites whole, before Chrome sees them, so feeds-only mode does nothing while they're on. `focus feeds add` offers to turn them off: press Enter and it runs `focus remove youtube` for you. `focus add youtube` blocks all of YouTube again whenever you want.

### Allowing subreddits

```bash
focus reddit allow rust AskHistorians    # also accepts r/rust or a subreddit URL
focus reddit disallow <name...>          # take them off the list
focus reddit list
```

Once you've allowed a subreddit, Chrome loads only the subreddits on your list while focus is on. Like `feeds add`, `reddit allow` offers to turn off the `reddit` preset, which would otherwise block every subreddit. Check that an allowed subreddit loads and another one shows focus's blocked page. If it doesn't, `focus add reddit` blocks all of Reddit again.

While focus is on:

- **Loads:** the allowed subreddits on any Reddit hostname (`www`, `old`, `new` and so on), including their posts, galleries, images and video; signing in; links to other sites; and `redd.it` shortlinks to posts in allowed subreddits.
- **Blocked:** everything else on Reddit: the home page, `r/all` and `r/popular`, other subreddits, multireddits (`r/a+b`), profiles, and search. Within an allowed subreddit, its search (which can search all of Reddit), its duplicates page and its API pages are blocked too.
- **Posts are checked by where they really are.** A post opened through a link that doesn't name its subreddit (`redd.it/<id>`, `/comments/<id>`, `/gallery/<id>`), or under another subreddit's address, is checked against the subreddit the page itself names.
- **Not covered:** posts from other subreddits that Reddit shows inside an allowed page (recommendations, crossposts, sidebars). focus restricts which pages you can open, not every piece of content on them.

Reddit is only restricted once `~/.config/focus/subreddits.json` exists, so installing the extension for feeds alone leaves Reddit to the hosts file.

### How it works

- **Blocking:** the extension uses Chrome's declarativeNetRequest rules to block pages, and shows its own page explaining why. It never blocks scripts, images, video or API calls, so the pages that still work keep working when these sites change. They often change pages without a full reload; the extension notices and sends those tabs to the blocked page, so a page can flash briefly first. On YouTube, it also hides recommendations with a stylesheet, which follows focus on and off without a reload.
- **Your settings:** `~/.config/focus/subreddits.json` and `~/.config/focus/feeds.json` belong to you. They're separate from `/etc/hosts` and from `config.json`, and root never reads them.
- **Knowing what Chrome did:** focus reads each Chrome profile's `Secure Preferences` (never writes it) to see whether the extension is loaded from its folder and allowed in Incognito.
- **Opening Chrome's pages:** `chrome://` pages can't be links in a terminal, because Chrome doesn't register that scheme with macOS, and Chrome ignores them as command-line arguments. focus opens them with `open -a "Google Chrome"`, which Chrome does accept.
- **On or off:** the extension asks focus whether blocking is on and what's set. Chrome starts the focus binary for each question (native messaging), and focus reads `/etc/hosts` and your settings, answers and exits. Nothing keeps running. The extension remembers the last answer, so if focus can't be reached, it keeps the last rules.
- **Stats:** the extension keeps the pages it saw blocked and sends them with its next question; focus appends them to `~/.config/focus/stats.jsonl`. It also answers with the hosts the hosts file blocks while on, so the extension can count failed loads of those sites. If focus can't save them, the extension keeps up to 1,000 and tries again.
- **Broken settings:** if `subreddits.json` can't be read, focus answers with an empty list; if `feeds.json` can't be read, it blocks every feed. Either way the blocked page says why, and `focus off` still turns blocking off.
- **Incognito:** the extension's own pages can't open in Incognito windows, so a blocked page there shows Chrome's "blocked" error page instead, sometimes for the site's home page rather than the link itself.

### Timing

- **First page after a change:** after `focus on`, `focus off` or a change to your settings, the first page you open on these sites still uses the previous rules. The extension corrects itself straight after, usually within a second, and sends any open tabs that are no longer allowed to the blocked page.
- **Tabs already open:** they catch up within about a minute, or sooner when you open another page on these sites.
- **The blocked page:** it checks again whenever you switch back to it, and returns to the link once it's allowed.

### Limits

- **Chrome only.** With a site's preset off, it's open in Safari, its apps, other Chrome profiles, and Incognito unless you allowed the extension there.
- **On and off with Chrome settings alone:** if you block nothing through the hosts file, focus still keeps its `# BEGIN focus` section there, holding only `# state: on` or `off`, because that's the switch the extension follows. Without any Chrome settings, removing your last site restores the hosts file exactly, as before.
- **Sites change.** YouTube and X rename their pages and page elements from time to time. When they do, a feed or a recommendation can slip through until focus is updated.
- **Keep Developer mode on.** Chrome disables an extension loaded from a folder when it reloads, such as after an update, if Developer mode is off. Chrome may also remind you that a developer-mode extension is installed.
- **After `focus upgrade`:** focus updates the extension's files; restart Chrome to use the new version (or click ↻ on focus at `chrome://extensions`). The extension may also reload itself the next time it talks to focus, but restarting is the sure way. `focus chrome update` updates the files by hand; you never need to load the extension again.

### Removing it

```bash
focus chrome uninstall           # removes the extension's folder and focus's registration with Chrome
focus add reddit youtube x       # blocks those sites whole again
```

If Chrome still has the extension loaded, `uninstall` offers to open its details page so you can click **Remove**. Your settings stay in `~/.config/focus/`.

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

7. **Remove the Chrome extension,** if you set it up. The extension keeps its last rules when it can't reach focus, so neither `focus off` nor the steps above lift its blocks in Chrome if focus is broken. Remove "focus" at `chrome://extensions`, then delete what `focus chrome install` wrote:

   ```bash
   rm -rf ~/Library/Application\ Support/focus/chrome-extension
   rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.brentvatne.focus.json
   ```

8. **Flush DNS and verify:**

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
- `presets.ts` and `prompt.ts`: the presets, and the per-site list `init` and `config` show
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
