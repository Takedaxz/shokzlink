#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
unset VIRTUAL_ENV PYTHONPATH PYTHONHOME
if ! command -v uv >/dev/null 2>&1; then
  printf 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/\n' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf 'Install Node.js 22 or later first: https://nodejs.org/\n' >&2
  exit 1
fi
uv sync --locked
if [ ! -d frontend/node_modules ]; then
  npm ci --prefix frontend
fi
npm run build --prefix frontend
printf '\nShokzLink: http://127.0.0.1:8765\nKeep this window open; press Control-C to stop.\n\n'
exec uv run --no-sync uvicorn backend.app:app --host 127.0.0.1 --port 8765 --reload --reload-dir backend
