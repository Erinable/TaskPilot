#!/usr/bin/env bash
# Runs before `npm run dev` and `npm start`. An install with --ignore-scripts
# leaves node_modules/electron without its binary, and electron-vite then
# fails with a bare "Electron uninstall" stack; say how to fix it instead.
set -euo pipefail

electron="$(cd -- "$(dirname -- "$0")/.." && pwd -P)/node_modules/electron"
[[ -d "$electron" ]] || { echo 'Electron is not installed: run npm install' >&2; exit 1; }
binary="$(cat -- "$electron/path.txt" 2>/dev/null || true)"
if [[ -z "$binary" || ! -e "$electron/dist/$binary" ]]; then
  echo 'The Electron binary is missing (installed with --ignore-scripts?).' >&2
  echo 'Restore it with: npm rebuild electron' >&2
  exit 1
fi
