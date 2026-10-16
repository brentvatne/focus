// Small terminal niceties: clickable links (OSC 8) and text styles, each only where the
// terminal supports it, so piped output stays plain text.

/**
 * Whether the terminal turns OSC 8 sequences into clickable links. Terminals that don't
 * know them may print garbage, so this only says yes for ones known to support them.
 * FORCE_HYPERLINK=1 or 0 overrides, as in the `supports-hyperlinks` package.
 */
export function supportsHyperlinks(env: Record<string, string | undefined>, isTerminal: boolean): boolean {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== "0";
  if (!isTerminal || env.CI) return false;
  const program = env.TERM_PROGRAM;
  if (program === "iTerm.app" || program === "WezTerm" || program === "ghostty" || program === "vscode") return true;
  // tmux replaces TERM_PROGRAM; iTerm2 still sets LC_TERMINAL, and kitty and Ghostty set TERM.
  if (env.LC_TERMINAL === "iTerm2") return true;
  return env.TERM === "xterm-kitty" || env.TERM === "xterm-ghostty" || env.KITTY_WINDOW_ID !== undefined;
}

/** `text` as a link to `url`, or just `text` when links aren't supported. */
export function hyperlink(text: string, url: string, enabled: boolean): string {
  return enabled ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

/** A file:// URL for a path, which opens it in Finder. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function styles(color: boolean) {
  const wrap = (open: number, close: number) => (text: string) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), yellow: wrap(33, 39) };
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
