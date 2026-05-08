#!/bin/sh
# Example operator-owned PR Shepherd notification wrapper for Telegram/OpenClaw field deployment.
#
# Install this outside the repository, for example as:
#   /usr/local/bin/pr-shepherd-openclaw-telegram-notify
#
# PR Shepherd passes notification metadata in PR_SHEPHERD_* environment variables.
# This wrapper intentionally defaults to dry-run/no-send. Live delivery requires:
#   PR_SHEPHERD_NOTIFY_DRY_RUN=0
#   PR_SHEPHERD_TELEGRAM_BOT_TOKEN_FILE=<operator-managed readable file>
#   PR_SHEPHERD_TELEGRAM_CHAT_ID_FILE=<operator-managed readable file>
#
# Keep token files, chat routing, and any OpenClaw/Gateway credentials out of this repo.

set -eu

die() {
  printf '%s\n' "pr-shepherd telegram wrapper: $*" >&2
  exit 2
}

first_line() {
  file=$1
  [ -r "$file" ] || die "required file is not readable: $file"
  sed -n '1p' "$file"
}

message=${PR_SHEPHERD_MESSAGE:-}
[ -n "$message" ] || die 'PR_SHEPHERD_MESSAGE is required'

target=${PR_SHEPHERD_TARGET:-unknown-target}
pr=${PR_SHEPHERD_PR:-unknown-pr}
url=${PR_SHEPHERD_URL:-}
kind=${PR_SHEPHERD_KIND:-unknown-kind}
key=${PR_SHEPHERD_KEY:-unknown-key}
prefix=${PR_SHEPHERD_TELEGRAM_PREFIX:-PR Shepherd}
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
  printf 'pr-shepherd telegram wrapper dryRun=1 target=%s kind=%s key=%s bytes=%s\n' \
    "$target" "$kind" "$key" "$bytes"
  exit 0
fi

command -v curl >/dev/null 2>&1 || die 'curl is required for live Telegram delivery'

token_file=${PR_SHEPHERD_TELEGRAM_BOT_TOKEN_FILE:-}
chat_file=${PR_SHEPHERD_TELEGRAM_CHAT_ID_FILE:-}
[ -n "$token_file" ] || die 'PR_SHEPHERD_TELEGRAM_BOT_TOKEN_FILE is required when PR_SHEPHERD_NOTIFY_DRY_RUN=0'
[ -n "$chat_file" ] || die 'PR_SHEPHERD_TELEGRAM_CHAT_ID_FILE is required when PR_SHEPHERD_NOTIFY_DRY_RUN=0'

token=$(first_line "$token_file")
chat_id=$(first_line "$chat_file")
[ -n "$token" ] || die 'Telegram token file is empty'
[ -n "$chat_id" ] || die 'Telegram chat id file is empty'

api_base=${PR_SHEPHERD_TELEGRAM_API_BASE:-https://api.telegram.org}
case "$api_base" in
  http://*|https://*) ;;
  *) die 'PR_SHEPHERD_TELEGRAM_API_BASE must start with http:// or https://' ;;
esac

timeout=${PR_SHEPHERD_TELEGRAM_TIMEOUT_SECONDS:-15}

curl -fsS \
  --retry 2 \
  --max-time "$timeout" \
  --request POST "${api_base}/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat_id}" \
  --data-urlencode "text=${text}" \
  --data-urlencode 'disable_web_page_preview=true' \
  >/dev/null

printf 'pr-shepherd telegram wrapper delivered target=%s kind=%s key=%s bytes=%s\n' \
  "$target" "$kind" "$key" "$bytes"
