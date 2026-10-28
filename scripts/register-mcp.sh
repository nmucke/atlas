#!/usr/bin/env bash
# Register the Atlas MCP server with ChatGPT Desktop/Codex, Claude Desktop and
# Claude Code in one step. Safe to re-run; existing settings are preserved and
# changed configurations are backed up first.
#
#   ./scripts/register-mcp.sh [workspace-dir]
#
# Honors ATLAS_DATA_DIR and ATLAS_PORT; use the same values when starting Atlas.
set -euo pipefail

# Resolve a relative workspace argument against the caller's directory before
# switching to the checkout.
args=()
for arg in "$@"; do
  case "$arg" in
    -* | /* | [A-Za-z]:*) args+=("$arg") ;;
    *) args+=("$PWD/$arg") ;;
  esac
done

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required, but node was not found on PATH." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 24 ]; then
  echo "Node.js 24 or newer is required (found $(node --version))." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm ci
fi

node --experimental-strip-types scripts/setup-assistant.ts --claude-code ${args[@]+"${args[@]}"}

port="${ATLAS_PORT:-3210}"
echo
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${port}/api/info" 2>/dev/null; then
  echo "Atlas is running on port ${port}."
else
  echo "Atlas is not running yet. Start it with 'npm run build && npm start' (or 'npm run dev'); the MCP bridge needs it."
fi
echo "Restart ChatGPT Desktop and Claude Desktop to pick up the Atlas server."
