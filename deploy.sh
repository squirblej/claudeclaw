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
docker compose -f "$BOTS_DIR/docker-compose.yml" restart gardener chef dr-chad dr-bob bookworm coach coach-tom homebot

echo "Done. All bots running production @ $COMMIT"
