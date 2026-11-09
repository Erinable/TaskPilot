#!/usr/bin/env bash
# Checks the binary and optionally launches the supplied command for dev/start.
# An install with --ignore-scripts leaves Electron without its binary; explain
# the fix before starting electron-vite.
set -euo pipefail

electron="$(cd -- "$(dirname -- "$0")/.." && pwd -P)/node_modules/electron"
[[ -d "$electron" ]] || { echo 'Electron is not installed: run npm install' >&2; exit 1; }
binary="$(cat -- "$electron/path.txt" 2>/dev/null || true)"
if [[ -z "$binary" || ! -e "$electron/dist/$binary" ]]; then
  echo 'The Electron binary is missing (installed with --ignore-scripts?).' >&2
  echo 'Restore it with: npm rebuild electron' >&2
  exit 1
fi

if (( $# )); then
  # Electron-based terminals may export this to run Node utilities. The GUI
  # process needs desktop APIs, so clear it in the actual launch environment.
  unset ELECTRON_RUN_AS_NODE
  exec "$@"
fi
