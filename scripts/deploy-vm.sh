#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_SHA="${1:?target commit SHA is required}"
APP_DIR="/home/matheus_cordeirorf/AyaAhdi-bot"
SERVICE="alinhamento-bot.service"

cd "$APP_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy over tracked local changes in $APP_DIR" >&2
  exit 1
fi

git fetch --no-tags origin master
git cat-file -e "${TARGET_SHA}^{commit}"
git merge-base --is-ancestor "$TARGET_SHA" origin/master

PREVIOUS_SHA="$(git rev-parse HEAD)"
if [[ "$PREVIOUS_SHA" == "$TARGET_SHA" ]]; then
  echo "Commit $TARGET_SHA is already deployed."
  exit 0
fi

wait_for_health() {
  local started_at="$1"
  local attempt
  for attempt in $(seq 1 90); do
    if ! sudo systemctl is-active --quiet "$SERVICE"; then
      return 1
    fi
    if sudo journalctl -u "$SERVICE" --since "$started_at" --no-pager -o cat 2>/dev/null \
      | grep -Fq "Coletor conectado"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

DEPLOY_COMPLETE=0
rollback_on_failure() {
  local failed_status="$?"
  if [[ "$failed_status" -eq 0 || "$DEPLOY_COMPLETE" -eq 1 ]]; then
    return
  fi
  trap - EXIT
  set +e
  echo "Deployment failed; restoring $PREVIOUS_SHA." >&2
  sudo systemctl stop "$SERVICE"
  git reset --hard "$PREVIOUS_SHA"
  npm install --omit=dev --no-audit --no-fund
  sudo systemctl start "$SERVICE"
  local rollback_started_at
  rollback_started_at="$(date --iso-8601=seconds)"
  if ! wait_for_health "$rollback_started_at"; then
    echo "Rollback started the previous version, but its WhatsApp health check did not pass." >&2
  else
    echo "Rollback restored and verified $PREVIOUS_SHA."
  fi
  exit "$failed_status"
}
trap rollback_on_failure EXIT

sudo systemctl stop "$SERVICE"
git reset --hard "$TARGET_SHA"
npm install --omit=dev --no-audit --no-fund
sudo systemctl start "$SERVICE"
DEPLOY_STARTED_AT="$(date --iso-8601=seconds)"
if ! wait_for_health "$DEPLOY_STARTED_AT"; then
  echo "Bot did not reconnect to WhatsApp within 180 seconds." >&2
  exit 1
fi

DEPLOY_COMPLETE=1
trap - EXIT
echo "Deployment $TARGET_SHA is active and connected to WhatsApp."

