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
# STATIC CHECK: every CSS custom property referenced must be declared. A token
# used but never defined resolves to nothing and silently collapses layout —
# exactly how a broken home page shipped in v176/v177. Cheap, so run it first.
python3 - <<'PYEOF' || { echo "UNDEFINED CSS TOKENS — not releasing"; exit 1; }
import re,sys
bad=0
for f in ['trip.html','index.html']:
    s=open(f).read()
    used=set(re.findall(r'var\((--[a-z0-9-]+)\)',s))
    defined=set(re.findall(r'(--[a-z0-9-]+)\s*:',s))
    missing=sorted(used-defined)
    if missing:
        bad=1; print('  %s uses undefined tokens: %s'%(f,', '.join(missing)))
sys.exit(bad)
PYEOF

# UNIT tests (trip.js in a Node vm — proves the maths).
node --test tests/live-core.test.mjs >/dev/null 2>&1 \
  || { node --test tests/live-core.test.mjs; echo "UNIT TESTS FAILED — not releasing"; exit 1; }

# BROWSER tests (the real pages in Chromium — proves the APP works). The unit
# tests stub the DOM and Leaflet, so they passed while real bugs shipped. These
# are the gate that actually reflects what the user sees.
if [ -f tests/browser.test.mjs ]; then
  echo "==> running browser tests (real Chromium)"
  timeout 300 node --test tests/browser.test.mjs >/tmp/browser-test.log 2>&1 \
    || { tail -40 /tmp/browser-test.log; echo "BROWSER TESTS FAILED — not releasing"; exit 1; }
  grep -E "^# (pass|fail)" /tmp/browser-test.log | sed "s/^/    /"
fi

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

# Push the branch. This is the release; it must succeed.
PUSHED=0
for i in 1 2 3 4; do
  if git push origin gh-pages; then PUSHED=1; break; fi
  sleep $((2 ** i))
done
[ "$PUSHED" = 1 ] || { echo "PUSH FAILED — v$NEXT is NOT released"; exit 1; }

# Verify the remote really has this commit. Never report a release we did not
# confirm — a deploy that only *looks* successful is how stale builds hide.
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git ls-remote origin gh-pages | cut -f1)
[ "$LOCAL" = "$REMOTE" ] || { echo "VERIFY FAILED: remote is $REMOTE, expected $LOCAL"; exit 1; }

# Tags are best-effort: some proxies reject tag pushes. Say so rather than lie.
git push -f origin "v$NEXT" 2>/dev/null && echo "==> tag v$NEXT pushed" \
  || echo "==> note: tag v$NEXT is local only (remote rejected the tag push)"

echo "==> released v$NEXT ($(git rev-parse --short HEAD)) — verified on origin/gh-pages"
