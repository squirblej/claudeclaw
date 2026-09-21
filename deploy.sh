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

# EXCLUSION LIST — currently EMPTY. Entries here are skipped when restarting.
#
# beancount (Pacioli) sat here from 2026-08-21 until 2026-09-21, when Jack retired
# the bot: its container is gone and bot-stack removed the compose service, so the
# name can never appear in RUNNING_BOTS again. Removed as dead code rather than
# left to rot — this script exists because a hardcoded list rotted twice, and a
# named exception for a bot that no longer exists is that same rot in a new place.
# Verified before removing: `compose ps --services --status running` returns
# coach, coach-humph, coach-tom, dr-chad and no beancount; the still-running
# beancount-runner/beancount-fava containers belong to
# ~/services/beancount/docker-compose.yml, which this script never touches.
#
# THE REASON IS KEPT BECAUSE THE SHAPE WILL RECUR, not because this bot might come
# back. Add a bot here if it writes into a repo that something else auto-commits
# with `git add -A`. That combination turns an ill-timed restart from a dropped
# connection into a SILENT CORRUPTION, and the mechanism is worth reading in full
# before deciding a future bot is safe:
#
# WHY, and it is worse than "a restart mid-cycle is untidy". Pacioli edited the
# cycle files DIRECTLY — they are its main edit surface — and neither validates
# nor commits them. Summa detects completion by the chat disappearing from
# pending_chats.json, and only then runs bean-check and either commits or
# surgically reverts. So if the process dies after edits are written but before
# the chat clears: the chat never clears, Summa's poller times out after five
# minutes, and the timeout branch marks the run failed and returns WITHOUT
# rolling back. Unvalidated edits sit in the working tree. Then git_autocommit
# stages with `git add -A`, so the NEXT Summa action that commits anything at
# all sweeps that orphaned half-edit into an unrelated commit under someone
# else's message — committed, pushed, diff intact, provenance gone. On the
# hand-reviewed cycle files Jack has said never to regenerate.
#
# summa-app is fixing the timeout branch to roll back its own delta, and STILL
# wants this exclusion afterwards: it downgrades an ill-timed restart from
# corrupting the record to merely losing an in-flight cycle, and nothing about
# a plugin deploy needs to restart that bot at all.
#
# Note the old hardcoded list did NOT include beancount, so deploy has never
# restarted it. Switching to "everything running" therefore does not merely
# tidy the list — it newly exposes beancount, and this script is what would do
# the exposing.
#
# bot-stack raised the SHAPE of the risk without asserting it (it was idle when
# checked, so nothing was visible) and routed the question to summa-app, who own
# it. Neither of us could have derived the mechanism above — it took the owner
# explaining their own commit machinery. Cost of excluding: beancount does not
# pick up plugin deploys, and the run says so out loud.
DEPLOY_RESTART_EXCLUDE=()
for _ex in "${DEPLOY_RESTART_EXCLUDE[@]}"; do
  for _i in "${!RUNNING_BOTS[@]}"; do
    if [ "${RUNNING_BOTS[$_i]}" = "$_ex" ]; then
      unset 'RUNNING_BOTS[_i]'
      echo "  SKIPPING $_ex — excluded from restart; see DEPLOY_RESTART_EXCLUDE above."
    fi
  done
done
RUNNING_BOTS=("${RUNNING_BOTS[@]}")   # reindex after unset

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
