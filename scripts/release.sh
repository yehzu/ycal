#!/bin/sh
# yCal release driver — turns a clean "bumped + committed" state into a
# published GitHub release that the in-app updater (src/main/updater.ts)
# picks up on existing installs. Designed to be called by `npm run release`.
#
# Pre-conditions (caller's responsibility):
#   • package.json version is what you want released
#   • the bump commit is HEAD on `main`
#   • working tree is clean (any unrelated changes should be committed
#     first; this script refuses to run on a dirty tree to avoid mixing
#     them into the release)
#
# Steps:
#   1. Pull GH_TOKEN from `gh auth token` (no manual env setup).
#   2. Typecheck + build (early failure if something's broken).
#   3. Tag vX.Y.Z if it doesn't exist yet.
#   4. Push the commit and the tag to origin.
#   5. `npm run dist -- --publish always` → builds dmg + zip, uploads to
#      a draft GitHub release named after the tag.
#   6. `gh release edit vX.Y.Z --draft=false` → promotes draft to live.
#      Existing installs poll GitHub on launch / focus / every 30 min and
#      pick it up within minutes of returning to the app.
set -eu

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not installed (brew install gh)" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh CLI not authenticated (run: gh auth login)" >&2
  exit 1
fi

if ! git diff-index --quiet HEAD --; then
  echo "ERROR: working tree not clean. Commit your bump first." >&2
  git status --short
  exit 1
fi

if [ ! -f build/oauth-client.json ]; then
  echo "ERROR: build/oauth-client.json missing." >&2
  echo "Releases bundle the OAuth client into Contents/Resources so new" >&2
  echo "installs don't have to set up Google Cloud Console themselves." >&2
  echo "Create a Desktop OAuth client at https://console.cloud.google.com/" >&2
  echo "and save the downloaded JSON as build/oauth-client.json." >&2
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

# Don't release the same version twice.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "WARN: tag $TAG already exists locally — assuming retry, not re-tagging."
else
  git tag "$TAG"
fi

echo "→ typechecking + building"
npm run typecheck
npm run build

echo "→ pushing main + $TAG"
git push origin main
git push origin "$TAG"

echo "→ publishing dmg/zip to GitHub draft release"
GH_TOKEN=$(gh auth token) npm run dist -- --publish always

echo "→ promoting draft to live release"
gh release edit "$TAG" --draft=false

echo ""
echo "✅ Released $TAG"
echo "   https://github.com/yehzu/ycal/releases/tag/$TAG"
