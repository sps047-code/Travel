#!/usr/bin/env bash
# =============================================================================
# release.sh — the ONE place a version is set.
#
# The version used to be typed by hand into four files (trip.js, sw.js and two
# places in trip.html). They drifted, which is how the app ended up reporting
# two different versions at once. This stamps every file from a single source
# of truth, runs the tests, commits, tags and pushes.
#
#   ./release.sh "what changed"
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

CURRENT=$(grep -o "APP_CODE_VERSION='v[0-9]*'" trip.js | grep -o '[0-9]*')
NEXT=$((CURRENT + 1))
MSG="${1:-release v$NEXT}"
echo "==> v$CURRENT -> v$NEXT"

# Never ship a build that fails its own tests or cannot be parsed.
node -e "new Function(require('fs').readFileSync('trip.js','utf8'))"
node -e "new Function(require('fs').readFileSync('trip-extras.js','utf8'))"
node -e "new Function(require('fs').readFileSync('sw.js','utf8'))"
node --test tests/*.test.mjs >/dev/null 2>&1 || { node --test tests/*.test.mjs; echo "TESTS FAILED — not releasing"; exit 1; }

# Stamp the single version into every file that must agree.
sed -i "s/APP_CODE_VERSION='v$CURRENT'/APP_CODE_VERSION='v$NEXT'/" trip.js
sed -i "s/seasons-v$CURRENT/seasons-v$NEXT/" sw.js
sed -i "s/?v=$CURRENT/?v=$NEXT/g" trip.html sw.js
sed -i "s/el.textContent='v$CURRENT'/el.textContent='v$NEXT'/" trip.html

# Verify they really do agree before anything is committed.
BAD=$(grep -o "v$CURRENT\b" trip.js sw.js trip.html || true)
[ -z "$BAD" ] || { echo "STALE VERSION LEFT BEHIND:"; echo "$BAD"; exit 1; }
echo "==> stamped v$NEXT in trip.js, sw.js, trip.html"

git add -A trip.js trip-extras.js sw.js trip.html index.html tests/ release.sh CHANGELOG.md 2>/dev/null || true
git commit -q -m "v$NEXT: $MSG"
git tag -f "v$NEXT" -m "v$NEXT: $MSG"

for i in 1 2 3 4; do
  git push origin gh-pages && git push -f origin "v$NEXT" && break
  sleep $((2 ** i))
done
echo "==> released v$NEXT ($(git rev-parse --short HEAD))"
