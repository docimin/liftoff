#!/usr/bin/env bash
#
# Liftoff installer — download the right binary for your platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/docimin/liftoff/main/scripts/install.sh | bash
#
set -euo pipefail

REPO="docimin/liftoff"
INSTALL_DIR="${LIFTOFF_INSTALL_DIR:-/usr/local/bin}"

# Detect OS
case "$(uname -s)" in
  Linux*)   OS="linux" ;;
  Darwin*)  OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *)
    echo "Error: Unsupported operating system: $(uname -s)"
    exit 1
    ;;
esac

# Detect architecture
case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64)  ARCH="arm64" ;;
  *)
    echo "Error: Unsupported architecture: $(uname -m)"
    exit 1
    ;;
esac

BINARY="liftoff-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then
  BINARY="${BINARY}.exe"
fi

# Get latest release tag
echo "Fetching latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')

if [ -z "$LATEST" ]; then
  echo "Error: Could not determine latest release."
  echo "Check that the repository ${REPO} exists and has releases."
  exit 1
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${LATEST}/${BINARY}"

echo "Downloading liftoff v${LATEST} for ${OS}/${ARCH}..."
echo "  ${DOWNLOAD_URL}"

# Download
TMPFILE=$(mktemp)
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMPFILE"; then
  echo "Error: Download failed."
  echo "  Binary '${BINARY}' may not exist for your platform."
  echo "  Check: https://github.com/${REPO}/releases/tag/v${LATEST}"
  rm -f "$TMPFILE"
  exit 1
fi

# Verify checksum if available
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/v${LATEST}/checksums.txt"
CHECKSUMS_TMP=$(mktemp)
if curl -fsSL "$CHECKSUMS_URL" -o "$CHECKSUMS_TMP" 2>/dev/null; then
  EXPECTED=$(grep "$BINARY" "$CHECKSUMS_TMP" | awk '{print $1}')
  if [ -n "$EXPECTED" ]; then
    ACTUAL=$(shasum -a 256 "$TMPFILE" | awk '{print $1}')
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      echo "Error: Checksum mismatch!"
      echo "  Expected: $EXPECTED"
      echo "  Got:      $ACTUAL"
      rm -f "$TMPFILE" "$CHECKSUMS_TMP"
      exit 1
    fi
    echo "Checksum verified."
  fi
fi
rm -f "$CHECKSUMS_TMP"

# Install
chmod +x "$TMPFILE"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/liftoff"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/liftoff"
fi

echo ""
echo "liftoff v${LATEST} installed to ${INSTALL_DIR}/liftoff"
echo ""
echo "Get started:"
echo "  liftoff plan     # create a migration plan"
echo "  liftoff run      # execute a migration plan"
echo "  liftoff --help   # show all commands"
