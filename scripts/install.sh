#!/usr/bin/env bash
#
# anton installer (anton-1xp.3) — one-command install of a prebuilt anton runtime, no toolchain
# and no build required. Mirrors the foolery model: fetch a per-platform prebuilt bundle from a
# GitHub Release, drop it under ~/.local/share/anton, and symlink the `anton` launcher onto PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/henriblancke/anton/main/scripts/install.sh | bash
#
# Env overrides:
#   ANTON_RELEASE_TAG   release to install (default: latest)
#   ANTON_BUNDLE_FILE   install from a LOCAL bundle tarball instead of downloading (testing)
#   ANTON_HOME          install root      (default: ~/.local/share/anton)
#   ANTON_BIN_DIR       launcher location (default: ~/.local/bin)
#   ANTON_RELEASE_OWNER / ANTON_RELEASE_REPO   GitHub repo (default: henriblancke/anton)
#
set -euo pipefail

OWNER="${ANTON_RELEASE_OWNER:-henriblancke}"
REPO="${ANTON_RELEASE_REPO:-anton}"
TAG="${ANTON_RELEASE_TAG:-latest}"
INSTALL_ROOT="${ANTON_HOME:-$HOME/.local/share/anton}"
BIN_DIR="${ANTON_BIN_DIR:-$HOME/.local/bin}"
RUNTIME="$INSTALL_ROOT/runtime"
LINK="$BIN_DIR/anton"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Detect platform → the release-asset label (must match scripts/build-bundle.mjs) ──────────
os_raw="$(uname -s)"
arch_raw="$(uname -m)"
case "$os_raw" in
  Darwin) os="darwin" ;;
  Linux)  os="linux"  ;;
  *) die "unsupported OS: $os_raw (anton bundles target macOS and Linux)" ;;
esac
case "$arch_raw" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64"   ;;
  *) die "unsupported architecture: $arch_raw" ;;
esac
asset="anton-${os}-${arch}.tar.gz"

say "Installing anton ($os-$arch)"

command -v node >/dev/null 2>&1 || info "note: anton needs Node ≥ 20 on PATH to run (not required to install)."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ── Obtain the bundle tarball (local file for testing, else download from the Release) ────────
tarball="$tmp/$asset"
if [ -n "${ANTON_BUNDLE_FILE:-}" ]; then
  [ -f "$ANTON_BUNDLE_FILE" ] || die "ANTON_BUNDLE_FILE not found: $ANTON_BUNDLE_FILE"
  info "using local bundle: $ANTON_BUNDLE_FILE"
  cp "$ANTON_BUNDLE_FILE" "$tarball"
else
  command -v curl >/dev/null 2>&1 || die "curl is required to download anton."
  if [ "$TAG" = "latest" ]; then
    url="https://github.com/$OWNER/$REPO/releases/latest/download/$asset"
  else
    url="https://github.com/$OWNER/$REPO/releases/download/$TAG/$asset"
  fi
  info "downloading $url"
  curl -fSL --retry 3 -o "$tarball" "$url" \
    || die "download failed — is there a $asset asset on the $TAG release?"
fi

# ── Extract and install the runtime (top-level entry is anton-<os>-<arch>/) ───────────────────
info "extracting…"
tar -xzf "$tarball" -C "$tmp"
extracted="$tmp/anton-${os}-${arch}"
[ -d "$extracted" ] || die "unexpected bundle layout (no anton-${os}-${arch}/ directory)."

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
rm -rf "$RUNTIME.old"
[ -d "$RUNTIME" ] && mv "$RUNTIME" "$RUNTIME.old"
mv "$extracted" "$RUNTIME"
rm -rf "$RUNTIME.old"

chmod +x "$RUNTIME/bin/anton.mjs"
ln -sf "$RUNTIME/bin/anton.mjs" "$LINK"

say "✓ anton installed → $RUNTIME"
info "launcher: $LINK"

# ── PATH hint + next steps ────────────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) info "add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<EOF

Next:
  anton setup      # check prereqs, create the local DB, install skills/agents
  anton start      # start the server (background) → http://localhost:3000
  anton status     # is it running? where?
  anton update     # upgrade to the latest release later
EOF
