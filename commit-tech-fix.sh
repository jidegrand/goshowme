#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# 1) Clear any stale locks from the prior session
rm -f .git/index.lock .git/HEAD.lock .git/refs/heads/main.lock

# 2) Sanity-check that nothing else is staged that shouldn't be
echo "── Status before commit ──"
git status --short

# 3) Stage and commit only the file we touched
git add public/tech.html

git commit -m "fix(tech): restore upright portrait + scene-coord annotation math

- normalizedRotationDeg back to plain counter-rotation; angle=0 maps
  to 0° so iOS Safari's CVO-corrected portrait stays upright.
- New effectiveRotationDeg() is the single source of truth shared by
  the CSS transform and the annotation hit-testing.
- getNorm() inverse-rotates the click into the scene's own coord
  frame so right-drag => right-arrow regardless of quadrant."

# 4) Push to the same remote tracking branch
git push
