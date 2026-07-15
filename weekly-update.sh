#!/bin/bash
# Weekly board updater, run by launchd (com.pga.board.update) every Monday.
# Rebuilds the board for the upcoming event, then commits & pushes if anything changed.
# Safe to fail: if pgatour.com can't be reached the build exits non-zero and we leave
# the existing board untouched.
#
# Run by hand:  ./weekly-update.sh    (tail -f weekly-update.log to watch)

cd "$(dirname "$0")" || exit 1
# launchd starts with a bare PATH - make sure node + git are findable.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# API keys (gitignored): THE_ODDS_API_KEY for live odds, ANTHROPIC_API_KEY for the AI deep-dive.
[ -f .env ] && set -a && . ./.env && set +a

LOG="weekly-update.log"
{
  echo "──────── $(date '+%Y-%m-%d %H:%M:%S') ────────"

  if ! node build.mjs < /dev/null; then
    echo "Build failed (pgatour.com unreachable or schema changed). Board left unchanged."
    exit 0
  fi

  if git rev-parse --git-dir > /dev/null 2>&1; then
    if git diff --quiet -- data.js data.json index.html ledger.json shadow-ledger.json; then
      echo "No change in picks - nothing to publish."
      exit 0
    fi
    git add data.js data.json index.html ledger.json shadow-ledger.json
    git commit -m "Board update $(date +%F)" && git push && echo "✓ Published to GitHub Pages." \
      || echo "✗ Commit/push failed - check git auth / remote."
  else
    echo "Built locally (no git repo yet - see README to enable hosting)."
  fi
} >> "$LOG" 2>&1
