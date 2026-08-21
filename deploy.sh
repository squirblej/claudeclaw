#!/usr/bin/env bash
# Deploy production branch to the ClaudeClaw plugin cache and restart all bots.
# Run from any directory; always deploys the 'production' branch regardless of
# what is currently checked out in the working tree.
#
# Usage:
#   ./deploy.sh           — deploy production and restart all bots
#   ./deploy.sh --dry-run — show what would be copied, don't restart

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HOME/.claude/plugins/cache/claudeclaw/claudeclaw/1.0.0"
BOTS_DIR="/home/jack/bots"
DRY_RUN=false

for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

# Verify production branch exists
if ! git -C "$REPO" rev-parse --verify production >/dev/null 2>&1; then
  echo "Error: 'production' branch not found in $REPO" >&2
  exit 1
fi

COMMIT=$(git -C "$REPO" rev-parse --short production)
echo "Deploying production @ $COMMIT to $CACHE"

if $DRY_RUN; then
  echo "[dry-run] Would extract: src/ package.json → $CACHE"
  git -C "$REPO" archive production src/ package.json | tar -t
  exit 0
fi

# Extract production branch src/ and package.json into cache
git -C "$REPO" archive production src/ package.json | tar -x -C "$CACHE"

echo "Plugin cache updated."
echo "Restarting berty..."
sudo systemctl restart berty

echo "Restarting Docker bots..."
# Ask compose what is RUNNING rather than hardcoding names. The old hardcoded
# list rotted twice in four days and was wrong in three directions at once:
# it named two bots whose containers no longer exist (harmless no-op), two
# whose containers still EXIST but are stopped — chef and homebot — and
# `docker compose restart` acts on an existing container regardless of whether
# its service is profiled out, so every deploy silently resurrected retired
# Michel onto Discord and started the paused homebot container alongside the
# live host session; and it omitted coach-humph and beancount, which are live
# and were therefore never picking up newly deployed plugin code.
# (bot-stack found and empirically verified this, 2026-08-21.)
COMPOSE=(docker compose -f "$BOTS_DIR/docker-compose.yml")
mapfile -t RUNNING_BOTS < <("${COMPOSE[@]}" ps --services --status running)

# Guard the empty case explicitly. If the expansion is empty, the command
# degrades to a bare `docker compose restart`, which acts on every service in
# the file rather than the set we computed.
#
# MEASURED, not assumed — an earlier draft of this comment claimed a bare
# restart would resurrect the retired bots, and that is WRONG: `ps --services`
# lists only profiled-IN services (today the same six), so chef and homebot
# are excluded from it. Naming them explicitly is what reaches a profiled-out
# container, which is why the old hardcoded list resurrected them and a bare
# restart would not.
#
# The guard still earns its place: an empty expansion means we could not
# determine what is running (docker down, wrong compose path), and silently
# acting on a different set than the one we computed is how the hardcoded list
# rotted in the first place. Refuse and say so rather than proceed on a set
# nobody chose.
if [ ${#RUNNING_BOTS[@]} -eq 0 ]; then
  echo "  NO running bot containers found — restarting NOTHING." >&2
  echo "  (Refusing to run a bare 'compose restart', which would start ALL" >&2
  echo "   services including retired ones. If bots should be running, check" >&2
  echo "   the docker daemon and $BOTS_DIR/docker-compose.yml, then re-run.)" >&2
else
  echo "  restarting: ${RUNNING_BOTS[*]}"
  "${COMPOSE[@]}" restart "${RUNNING_BOTS[@]}"
fi

echo "Done. All bots running production @ $COMMIT"
