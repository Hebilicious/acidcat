#!/usr/bin/env bash
# Approves the `pull_request` runs of a pull request that a workflow opened or updated with GITHUB_TOKEN.
#
# GitHub creates these runs, but holds them with the conclusion `action_required` until someone approves them. The
# required checks of the pull request come from these runs, so the pull request cannot merge until they run.
#
# The script waits until each workflow in .github/workflows that has a `pull_request` trigger has a run for the head
# commit of the pull request, and approves each run that waits. It fails after five minutes.
#
# Usage: scripts/approve-pull-request-runs.sh <pull request number>
# Needs GH_TOKEN with `actions: write`, and GITHUB_REPOSITORY.
set -euo pipefail

number=$1
head=$(gh pr view "$number" --repo "$GITHUB_REPOSITORY" --json headRefOid --jq .headRefOid)
expected=$(grep -lE '^  pull_request:' .github/workflows/*.yml | wc -l)
deadline=$((SECONDS + 300))

while true; do
  runs=$(gh run list --repo "$GITHUB_REPOSITORY" --commit "$head" --event pull_request --json databaseId,conclusion)
  for id in $(jq -r '.[] | select(.conclusion == "action_required") | .databaseId' <<< "$runs"); do
    gh api --method POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/approve" > /dev/null
    echo "Approved run $id."
  done
  started=$(jq '[.[] | select(.conclusion != "action_required")] | length' <<< "$runs")
  if [ "$started" -ge "$expected" ]; then
    echo "All $expected pull_request runs of $head run."
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Only $started of $expected pull_request runs of $head started." >&2
    exit 1
  fi
  sleep 10
done
