#!/bin/sh
# Example operator-owned PR Shepherd notification wrapper for Telegram/OpenClaw field deployment.
#
# Install this outside the repository, for example as:
#   /usr/local/bin/pr-shepherd-openclaw-telegram-notify
#
# PR Shepherd passes notification metadata in PR_SHEPHERD_* environment variables.
# This wrapper intentionally defaults to dry-run/no-send. Live delivery requires:
#   PR_SHEPHERD_NOTIFY_DRY_RUN=0
#   PR_SHEPHERD_OPENCLAW_TARGET=<operator-managed chat/user target>
#
# Delivery goes through the OpenClaw CLI so OpenClaw owns Telegram routing,
# credentials, allowlists, and provider behavior. Do not put bot tokens,
# Gateway tokens, webhook secrets, or raw provider credentials in this repo.

set -eu

die() {
  printf '%s\n' "pr-shepherd openclaw wrapper: $*" >&2
  exit 2
}

message=${PR_SHEPHERD_MESSAGE:-}
[ -n "$message" ] || die 'PR_SHEPHERD_MESSAGE is required'

target=${PR_SHEPHERD_TARGET:-unknown-target}
pr=${PR_SHEPHERD_PR:-unknown-pr}
url=${PR_SHEPHERD_URL:-}
kind=${PR_SHEPHERD_KIND:-unknown-kind}
key=${PR_SHEPHERD_KEY:-unknown-key}
prefix=${PR_SHEPHERD_OPENCLAW_PREFIX:-PR Shepherd}
dry_run=${PR_SHEPHERD_NOTIFY_DRY_RUN:-1}

text=$(cat <<MSG
${prefix}
target=${target}
pr=${pr}
kind=${kind}
key=${key}
${message}
MSG
)

if [ -n "$url" ]; then
  text=$(cat <<MSG
${text}
url=${url}
MSG
)
fi

bytes=$(printf '%s' "$text" | wc -c | tr -d ' ')

if [ "$dry_run" != '0' ]; then
  printf 'pr-shepherd openclaw wrapper dryRun=1 target=%s kind=%s key=%s bytes=%s\n' \
    "$target" "$kind" "$key" "$bytes"
  exit 0
fi

openclaw_bin=${OPENCLAW_BIN:-openclaw}
channel=${PR_SHEPHERD_OPENCLAW_CHANNEL:-telegram}
delivery_target=${PR_SHEPHERD_OPENCLAW_TARGET:-}
[ -n "$delivery_target" ] || die 'PR_SHEPHERD_OPENCLAW_TARGET is required when PR_SHEPHERD_NOTIFY_DRY_RUN=0'

command -v "$openclaw_bin" >/dev/null 2>&1 || die "OpenClaw CLI not found: $openclaw_bin"

"$openclaw_bin" message send \
  --channel "$channel" \
  --target "$delivery_target" \
  --message "$text" \
  >/dev/null

printf 'pr-shepherd openclaw wrapper delivered channel=%s target=%s kind=%s key=%s bytes=%s\n' \
  "$channel" "$target" "$kind" "$key" "$bytes"
