#!/bin/bash
# Copy scraper output to web data directory
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

SOURCE="$ROOT_DIR/scraper/output/hackathons.json"
DEST="$ROOT_DIR/web/src/data/hackathons.json"

if [ ! -f "$SOURCE" ]; then
  echo "Error: $SOURCE not found. Run the scraper first."
  exit 1
fi

cp "$SOURCE" "$DEST"
echo "Copied $SOURCE -> $DEST"
