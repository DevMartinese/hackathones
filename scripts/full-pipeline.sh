#!/bin/bash
# Run full pipeline: scrape + process + copy to web
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Running scraper pipeline..."
cd "$ROOT_DIR/scraper"
uv run hackathons-scrape pipeline

echo "==> Copying data to web..."
bash "$SCRIPT_DIR/copy-data.sh"

echo "==> Building web..."
cd "$ROOT_DIR/web"
pnpm build

echo "==> Done!"
