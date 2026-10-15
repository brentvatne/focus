#!/bin/sh
# Installs the latest focus release to /usr/local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/brentvatne/focus/main/install.sh | sh
#
# FOCUS_VERSION=v0.1.0 installs a specific release; FOCUS_INSTALL_DIR changes the destination.
set -eu

REPO="brentvatne/focus"
ASSET="focus-darwin-arm64"
INSTALL_DIR="${FOCUS_INSTALL_DIR:-/usr/local/bin}"
VERSION="${FOCUS_VERSION:-}"

fail() {
  printf 'focus install: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "focus only supports macOS"
[ "$(uname -m)" = "arm64" ] || fail "releases are only built for Apple silicon (arm64), not $(uname -m)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  # gh is authenticated, which also works for a private fork.
  if [ -n "$VERSION" ]; then
    gh release download "$VERSION" -R "$REPO" -p "$ASSET" -p SHA256SUMS -D "$TMP"
  else
    gh release download -R "$REPO" -p "$ASSET" -p SHA256SUMS -D "$TMP"
  fi
else
  if [ -n "$VERSION" ]; then
    BASE="https://github.com/$REPO/releases/download/$VERSION"
  else
    BASE="https://github.com/$REPO/releases/latest/download"
  fi
  curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET" -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" ||
    fail "download failed. Check your connection, or install the GitHub CLI and run \`gh auth login\` first."
fi

(cd "$TMP" && shasum -a 256 -c SHA256SUMS >/dev/null) || fail "checksum mismatch; nothing was installed"
chmod 755 "$TMP/$ASSET"
NEW_VERSION="$("$TMP/$ASSET" --version)" || fail "the downloaded binary failed to run; nothing was installed"

SUDO=""
if ! { [ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; }; then
  echo "Installing to $INSTALL_DIR requires sudo."
  SUDO="sudo"
fi
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO install -m 755 "$TMP/$ASSET" "$INSTALL_DIR/focus"

echo "Installed focus $NEW_VERSION to $INSTALL_DIR/focus"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not on your PATH." ;;
esac
echo "Get started with: focus init"
echo "Optional: run \`focus setup-sudo\` once so focus can change /etc/hosts without asking for your password."
