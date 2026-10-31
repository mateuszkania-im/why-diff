#!/usr/bin/env bash
# Sticky PR comment for the why-diff GitHub Action (action.yml).
#
# Env: REPORT (markdown file), REPO (owner/name), HEAD_REPO (PR head owner/name),
# PR_NUMBER, RUNNER_TEMP, GH_TOKEN, optional COMMENT_AUTHOR (login owning the sticky comment). Never fails the job: a comment that cannot be
# posted is a warning, the report is already in the job summary.
set -euo pipefail

marker='<!-- why-diff:comment -->'

if [ -n "${HEAD_REPO:-}" ] && [ "$HEAD_REPO" != "$REPO" ]; then
  echo "::notice::why-diff: pull request from a fork, where the token is read-only; the report is in the job summary instead of a comment."
  exit 0
fi

body="$RUNNER_TEMP/why-diff-comment.md"
{ echo "$marker"; cat "$REPORT"; } > "$body"

# Only a comment written by this token's identity counts, so a marker planted by
# someone else is never edited. GITHUB_TOKEN cannot call /user; a PAT can.
login='github-actions[bot]'
author_ok=false
if [ -n "${COMMENT_AUTHOR:-}" ]; then
  if [[ "$COMMENT_AUTHOR" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]]; then
    author_ok=true
  else
    # Workflow-command escaping, so the value cannot start a command of its own.
    shown=${COMMENT_AUTHOR//%/%25}
    shown=${shown//$'\r'/%0D}
    shown=${shown//$'\n'/%0A}
    echo "::warning::invalid comment-author \"$shown\", using the default"
  fi
fi
if [ "$author_ok" = true ]; then
  login="$COMMENT_AUTHOR"
elif me=$(gh api user --jq .login 2>/dev/null) && [[ "$me" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]]; then
  login="$me"
fi

filter=".[] | select(.user.login == \"$login\" and (.body | startswith(\"$marker\"))) | .id"
if ! ids=$(gh api --paginate "repos/$REPO/issues/$PR_NUMBER/comments" --jq "$filter"); then
  echo "::warning::why-diff: could not list pull request comments; the report is in the job summary."
  exit 0
fi
id=$(printf '%s\n' "$ids" | sed -n '1p')

if [ -n "$id" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$id" -F "body=@$body" > /dev/null || {
    echo "::warning::why-diff: could not update the comment (does the workflow grant pull-requests: write?); the report is in the job summary."
  }
else
  gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -F "body=@$body" > /dev/null || {
    echo "::warning::why-diff: could not post the comment (does the workflow grant pull-requests: write?); the report is in the job summary."
  }
fi
exit 0
