#!/usr/bin/env bash
# Formdrop has no runtime dependencies, so "installing" means: check the
# toolchain, create the data directory, and seed the demo workspace.
# This script never starts the server -- run `node main.js` afterwards.
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js 20 or newer is required but 'node' is not on PATH." >&2
  echo "       See INSTALL.md for the prerequisites." >&2
  exit 1
fi

node -e '
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 20) {
  console.error("error: Node.js 20 or newer is required; found " + process.versions.node);
  process.exit(1);
}
'

mkdir -p data
node main.js --seed

echo ""
echo "Setup complete."
echo "  Start the server:  node main.js"
echo "  Then open:         http://localhost:3000"
echo "  Demo login:        cenius@cenius.ai / cenius"
echo ""
echo "Data lives in data/db.json (created on first run, kept across restarts)."
