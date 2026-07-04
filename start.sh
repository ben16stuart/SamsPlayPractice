#!/usr/bin/env bash
# One-command launcher for Sam's Play Practice.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Setting up (first run only)…"
  python3 -m venv .venv
  .venv/bin/pip install --quiet -r requirements.txt
fi

echo ""
echo "  🎭 Sam's Play Practice → http://localhost:5000"
echo ""
exec .venv/bin/python app.py
