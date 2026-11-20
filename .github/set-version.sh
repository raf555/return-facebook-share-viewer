#!/usr/bin/env bash
# Usage: set-version.sh <manifest.json> <version>
# Rewrites only the "version" line so the file's formatting stays as committed.
set -euo pipefail

manifest="$1"
version="$2"

sed -i -E "s/(\"version\": *\")[^\"]*\"/\1${version}\"/" "$manifest"

actual=$(jq -r .version "$manifest")
if [ "$actual" != "$version" ]; then
  echo "::error::$manifest has version $actual after update, expected $version"
  exit 1
fi
