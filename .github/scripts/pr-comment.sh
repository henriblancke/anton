#!/usr/bin/env bash
#
# The review agent's two comment writes, behind a fixed command token (anton-9zzu).
#
# Claude Code's `--allowedTools` Bash rules are WHITESPACE-TOKEN prefixes with no glob support, so
# no rule can ever cover `gh api repos/O/R/issues/comments/<id>`: the id is glued to the path token,
# the rule's prefix ends mid-token, and the call is denied. That is why the "sticky" summary was
# never sticky — on PR #217 the agent found its previous summary 52 times, had every PATCH refused,
# and fell through to "create a new comment" each run. Behind a fixed script path the variable id
# moves into an argument, where the matcher does not look.
#
# The repo, the PR and the bot login come from the workflow env, never from the agent, so a prompt
# injection in PR content cannot retarget the write. The agent supplies only the text.
#
#   pr-comment.sh sticky              # summary body on stdin; edits the marker comment in place
#   pr-comment.sh reply <id> <text>   # reply in the thread of review comment <id>
set -euo pipefail

# The identity of the summary comment. Owned here, never typed by the agent: an indented or missing
# marker is a comment the next run cannot find, which is a fresh summary every push.
MARKER='<!-- claude-review-summary -->'

# A write that fails must not be findable only by noticing the PR is missing a summary. The agent's
# stdout never reaches the runner's log (the action hides it), so the trail is the job summary page,
# which any process in the job can append to. The `::error::`/`::warning::` prefixes annotate the run
# when this script is called from a plain workflow step, and are a prefix the agent reports otherwise.
note() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "pr-comment.sh: $*" >>"$GITHUB_STEP_SUMMARY"
  return 0
}

die() {
  note "FAILED — $*"
  echo "::error::pr-comment.sh: $*" >&2
  exit 1
}

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
[[ -n "$REPO" ]] || die "REPO/GITHUB_REPOSITORY is unset"
[[ "${PR_NUMBER:-}" =~ ^[0-9]+$ ]] || die "PR_NUMBER must be a number (got '${PR_NUMBER:-}')"
# Fail loud rather than match nothing: an empty login silently makes every lookup below return
# "no previous summary", which is the duplicate storm again by another route.
[[ -n "${BOT_LOGIN:-}" ]] || die "BOT_LOGIN is unset — the summary lookup would match nothing"

# Newest first-class summary, or empty. `last` keeps the pre-existing duplicates on long-lived PRs
# untouched: the run edits the most recent one and leaves the history alone.
find_summary() {
  gh api "repos/$REPO/issues/$PR_NUMBER/comments" -X GET -F per_page=100 --paginate --slurp |
    jq -r --arg marker "$MARKER" --arg bot "$BOT_LOGIN" '
      [ .[][]
        | select(.user.login == $bot and ((.body // "") | sub("^[[:space:]]+"; "") | startswith($marker)))
        | .id
      ] | last // empty'
}

sticky() {
  local body id out url
  body="$(cat)"
  [[ -n "${body//[[:space:]]/}" ]] || die "refusing to post an empty summary"
  # Strip a marker the agent added itself, then prepend the canonical one.
  body="$(printf '%s\n' "$body" | sed -e '1s/^[[:space:]]*//' -e "1s|^${MARKER}||")"
  body="$MARKER"$'\n'"$body"

  id="$(find_summary)" || die "could not list existing comments on PR $PR_NUMBER"
  if [[ -n "$id" ]]; then
    if out="$(printf '%s\n' "$body" | gh api "repos/$REPO/issues/comments/$id" -X PATCH -F body=@- --jq .html_url 2>&1)"; then
      echo "pr-comment: edited summary $id ($out)"
      return 0
    fi
    # A deleted comment is the one benign failure. Anything else (auth, rate limit, another
    # permission gate) must be loud — a silent re-create is exactly how 52 summaries accumulated.
    grep -q "HTTP 404" <<<"$out" || die "PATCH of summary $id failed: $out"
    note "summary $id is gone; creating a replacement"
    echo "::warning::pr-comment.sh: summary $id is gone; creating a replacement" >&2
  fi
  url="$(printf '%s\n' "$body" | gh api "repos/$REPO/issues/$PR_NUMBER/comments" -X POST -F body=@- --jq .html_url)" ||
    die "could not create the summary comment"
  echo "pr-comment: created summary $url"
}

reply() {
  local id="${1:-}" text="${2:-}"
  [[ "$id" =~ ^[0-9]+$ ]] || die "reply needs a numeric review-comment id (got '${id}')"
  [[ -n "${text//[[:space:]]/}" ]] || die "reply needs a body"
  gh api "repos/$REPO/pulls/$PR_NUMBER/comments/$id/replies" -f body="$text" --jq .html_url ||
    die "could not reply to review comment $id"
}

case "${1:-}" in
  sticky) sticky ;;
  reply)
    shift
    reply "$@"
    ;;
  *) die "usage: pr-comment.sh sticky | pr-comment.sh reply <comment-id> <text>" ;;
esac
