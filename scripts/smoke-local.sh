#!/usr/bin/env bash
# Clean-start smoke test of the full local Compose stack, in an isolated Compose project.
#
#   scripts/smoke-local.sh [--keep] [--wait-all] [-p <project>]
#
# Builds the image, starts PostgreSQL/Valkey/Mailpit and the app services, applies
# config/local.example.json through the `config-apply` tools service, submits one email and
# checks that it reaches `accepted` and lands in Mailpit. The project is removed (down -v) on exit
# only if this script started it, unless --keep is given.
#
# Options:
#   -p, --project <name>  Compose project name (default: $SMOKE_PROJECT or ns-smoke)
#   --no-build            use the existing $NOTIFICATION_SERVICE_IMAGE instead of building it
#   --keep                keep the project running after the test
#   --wait-all            wait for every service healthcheck, ops server included (default)
#   --no-wait-all         wait only for api/infra; start dispatcher/worker without waiting
#
# Environment (host ports default to values that do not collide with the default local stack):
#   POSTGRES_PUBLISHED_PORT=15432 VALKEY_PUBLISHED_PORT=16379 MAILPIT_SMTP_PUBLISHED_PORT=11025
#   MAILPIT_UI_PUBLISHED_PORT=18025 API_PUBLISHED_PORT=13000 API_OPS_PUBLISHED_PORT=19100
#   NOTIFICATION_SERVICE_IMAGE=notification-service:smoke  (separate tag: the default stack's
#                                                          image is not overwritten)
#   SMOKE_TIMEOUT_S=60      delivery timeout; SMOKE_WAIT_TIMEOUT_S=180 startup timeout
#   SMOKE_API_KEY           API key to use when the tenant already exists (re-run with --keep)
#
# Requires: docker (Compose v2.24+), curl, jq. No Node.js on the host.
set -euo pipefail

project="${SMOKE_PROJECT:-ns-smoke}"
keep=false
wait_all=true
build_flag=--build
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p | --project)
      project="${2:?missing project name}"
      shift 2
      ;;
    --keep)
      keep=true
      shift
      ;;
    --wait-all)
      wait_all=true
      shift
      ;;
    --no-wait-all)
      wait_all=false
      shift
      ;;
    --no-build)
      build_flag=--no-build
      shift
      ;;
    -h | --help)
      sed -n '2,27p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

for tool in docker curl jq; do
  command -v "$tool" >/dev/null || {
    echo "missing required tool: $tool" >&2
    exit 2
  }
done

export POSTGRES_PUBLISHED_PORT="${POSTGRES_PUBLISHED_PORT:-15432}"
export VALKEY_PUBLISHED_PORT="${VALKEY_PUBLISHED_PORT:-16379}"
export MAILPIT_SMTP_PUBLISHED_PORT="${MAILPIT_SMTP_PUBLISHED_PORT:-11025}"
export MAILPIT_UI_PUBLISHED_PORT="${MAILPIT_UI_PUBLISHED_PORT:-18025}"
export API_PUBLISHED_PORT="${API_PUBLISHED_PORT:-13000}"
export API_OPS_PUBLISHED_PORT="${API_OPS_PUBLISHED_PORT:-19100}"
export NOTIFICATION_SERVICE_IMAGE="${NOTIFICATION_SERVICE_IMAGE:-notification-service:smoke}"
delivery_timeout="${SMOKE_TIMEOUT_S:-60}"
wait_timeout="${SMOKE_WAIT_TIMEOUT_S:-180}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
compose=(docker compose -p "$project" -f compose.yaml -f compose.override.yaml)
api="http://127.0.0.1:${API_PUBLISHED_PORT}"
mailpit="http://127.0.0.1:${MAILPIT_UI_PUBLISHED_PORT}/api/v1"

started_by_us=false
result=FAIL
step="startup"

log() { printf '[smoke] %s\n' "$*"; }

cleanup() {
  local code=$?
  if [[ "$result" != PASS ]]; then
    log "diagnostics (last service logs):"
    "${compose[@]}" ps -a 2>/dev/null || true
    "${compose[@]}" logs --no-color --tail 40 migrate api dispatcher worker-email 2>/dev/null || true
  fi
  if [[ "$started_by_us" == true && "$keep" == false ]]; then
    log "removing project $project (down -v)"
    "${compose[@]}" --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  elif [[ "$keep" == true ]]; then
    log "project $project kept (API $api, Mailpit http://127.0.0.1:${MAILPIT_UI_PUBLISHED_PORT})"
  fi
  if [[ "$result" == PASS ]]; then
    log "PASS"
  else
    log "FAIL at step: $step"
    [[ $code -eq 0 ]] && code=1
  fi
  exit "$code"
}
trap cleanup EXIT

if [[ "$project" == notification-service ]]; then
  echo "refusing to run against the default local project; pick another name with -p" >&2
  exit 2
fi
existing_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
if [[ -z "$("${compose[@]}" ps -a -q 2>/dev/null)" && -z "$existing_volumes" ]]; then
  started_by_us=true
else
  log "project $project already exists: it will not be removed at the end"
fi

step="compose up"
if [[ "$wait_all" == true ]]; then
  "${compose[@]}" up -d "$build_flag" --wait --wait-timeout "$wait_timeout"
else
  # dispatcher/worker readiness depends on the ops server (/health/ready on OPS_PORT): until it is
  # wired, wait only on api (and its dependencies) and Mailpit, then start the rest.
  "${compose[@]}" up -d "$build_flag" --wait --wait-timeout "$wait_timeout" api mailpit valkey
  "${compose[@]}" up -d --no-build dispatcher worker-email
fi
log "stack up: $("${compose[@]}" ps --format '{{.Service}}={{.State}}' | tr '\n' ' ')"

step="config-apply"
# Logs are JSON lines; only the "API key created" line carries the key. Never echo that line.
if ! config_output="$("${compose[@]}" run --rm -T config-apply 2>&1)"; then
  printf '%s\n' "$config_output" | grep -v 'API key created' >&2 || true
  exit 1
fi
api_key="$(printf '%s\n' "$config_output" | sed -n 's/^API key created for tenant "local-app" ([^)]*): \(ns_[A-Za-z0-9_-]*\)$/\1/p' | head -n 1)"
unset config_output
if [[ -z "$api_key" ]]; then
  api_key="${SMOKE_API_KEY:-}"
  [[ -n "$api_key" ]] || {
    log "config-apply printed no new API key (tenant already configured?); set SMOKE_API_KEY"
    exit 1
  }
  log "configuration applied; using SMOKE_API_KEY"
else
  log "configuration applied; API key captured (not shown)"
fi

step="submit notification"
token="smoke-$(date +%s)-$RANDOM"
body="$(jq -n --arg subject "Smoke $token" '{
  channel: "email",
  routingKey: "transactional",
  recipient: { email: "smoke@example.test" },
  content: { from: "Smoke <no-reply@example.test>", subject: $subject, text: "Smoke test." }
}')"
if ! response="$(curl --fail-with-body -sS -X POST "$api/v1/notifications" \
  -H "Authorization: Bearer $api_key" \
  -H "Idempotency-Key: $token" \
  -H 'Content-Type: application/json' \
  --data "$body")"; then
  log "POST /v1/notifications failed: $response"
  exit 1
fi
id="$(jq -r '.id' <<<"$response")"
log "notification $id submitted"

step="wait for accepted"
status=""
deadline=$((SECONDS + delivery_timeout))
while ((SECONDS < deadline)); do
  status="$(curl -fsS "$api/v1/notifications/$id" -H "Authorization: Bearer $api_key" |
    jq -r '.submissionStatus')"
  [[ "$status" == accepted ]] && break
  case "$status" in failed | unknown | suppressed | expired) break ;; esac
  sleep 1
done
[[ "$status" == accepted ]] || {
  log "submissionStatus=$status after ${delivery_timeout}s"
  exit 1
}
log "submissionStatus=accepted"

step="check Mailpit"
found=0
deadline=$((SECONDS + 15))
while ((SECONDS < deadline)); do
  found="$(curl -fsS "$mailpit/messages?limit=200" | jq --arg subject "Smoke $token" \
    '[.messages[] | select(.Subject == $subject and any(.To[]; .Address == "smoke@example.test"))] | length')"
  ((found > 0)) && break
  sleep 1
done
((found > 0)) || {
  log "message not found in Mailpit"
  exit 1
}
log "message found in Mailpit ($found)"

result=PASS
