#!/usr/bin/env bash
# Builds the installable zip: dist/linkedin-clay-sync-v<version>.zip
# The zip holds one folder, linkedin-clay-sync/, that Chrome can load unpacked.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
name="linkedin-clay-sync"
out="dist/${name}-v${version}.zip"
stage="dist/stage/${name}"

rm -rf dist/stage "$out"
mkdir -p "$stage"
cp manifest.json background.js db.js popup.html popup.js history.html history.js LICENSE "$stage/"
cp -R icons "$stage/icons"
find "$stage" -name '.DS_Store' -delete

(cd dist/stage && zip -qr -X "../${name}-v${version}.zip" "$name")
rm -rf dist/stage
echo "$out"
