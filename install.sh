#!/usr/bin/env sh
# Superbase installer for macOS and Linux.
#
# One line (read the script first if you want to, it is short):
#   curl -fsSL https://raw.githubusercontent.com/fiangg20/superbase/main/install.sh | sh
#
# What it does:
#   1. checks that Node.js 18 or newer is installed
#   2. downloads Superbase into ~/.superbase (git when it is installed, a tarball when it is not)
#   3. runs "npm install" for the one dependency
#   4. runs scripts/install.js, which registers the MCP server in the AI clients it finds
#
# Settings (environment variables, all optional):
#   SUPERBASE_DIR    where to install               default: ~/.superbase
#   SUPERBASE_REF    branch or tag to download      default: main
#   SUPERBASE_ARGS   arguments for scripts/install.js, for example "--yes" or "--client cursor,codex"
#   SUPERBASE_START  set to 1 to start the bridge when everything is done
#
# Uninstall the MCP entries again: node scripts/install.js --uninstall

set -eu

REPO="fiangg20/superbase"
REF="${SUPERBASE_REF:-main}"
DIR="${SUPERBASE_DIR:-}"

say() { printf '[superbase] %s\n' "$1"; }
stop() { printf '[superbase] %s\n' "$1" >&2; exit 1; }

# Use the folder this script sits in when it is run from a checkout.
if [ -z "$DIR" ] && [ -f "$0" ]; then
  here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
  if [ -n "$here" ] && [ -f "$here/scripts/install.js" ]; then DIR="$here"; fi
fi
[ -n "$DIR" ] || DIR="$HOME/.superbase"

# 1. Node.js
command -v node >/dev/null 2>&1 || stop "Node.js is not installed. Install version 18 or newer from https://nodejs.org (or with your package manager), then run this again."
NODE_VERSION=$(node --version)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || stop "Node.js $NODE_VERSION is too old, Superbase needs 18 or newer."
say "Node.js $NODE_VERSION found."

# 2. The code
if [ -f "$DIR/scripts/install.js" ] && [ ! -d "$DIR/.git" ]; then
  say "Using the files that are already in $DIR."
elif command -v git >/dev/null 2>&1 && [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only || stop "git pull failed. Fix the folder or delete it and run this again."
elif command -v git >/dev/null 2>&1; then
  if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then stop "$DIR exists and is not empty. Set SUPERBASE_DIR to another folder."; fi
  say "Cloning into $DIR"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$DIR" || stop "git clone failed."
else
  command -v curl >/dev/null 2>&1 || stop "Neither git nor curl is installed."
  command -v tar >/dev/null 2>&1 || stop "tar is not installed."
  say "git is not installed, downloading a tarball instead."
  mkdir -p "$DIR"
  curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz --strip-components=1 -C "$DIR" || stop "Download failed."
  say "Files are in $DIR"
fi

# 3. Dependencies
cd "$DIR"
say "Installing the dependency (npm install)..."
npm install --omit=dev --no-audit --no-fund --loglevel=error || stop "npm install failed."

# 4. Register the MCP server in the AI clients
set +e
# When this script is piped into sh, stdin is the script itself, so questions are read from the terminal.
# shellcheck disable=SC2086
if [ -t 0 ]; then
  node "$DIR/scripts/install.js" ${SUPERBASE_ARGS:-}
elif ( : </dev/tty ) 2>/dev/null; then
  node "$DIR/scripts/install.js" ${SUPERBASE_ARGS:-} </dev/tty
else
  node "$DIR/scripts/install.js" ${SUPERBASE_ARGS:-}
fi
code=$?
set -e

echo ""
say "Superbase is in $DIR"
say "Start the bridge with:  cd \"$DIR\" && npm start"
if [ "${SUPERBASE_START:-}" = "1" ]; then
  say "Starting the bridge..."
  npm start
fi
exit "$code"
