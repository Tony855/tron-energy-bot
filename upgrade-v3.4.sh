#!/usr/bin/env bash
# Safer V3.4 upgrade: encrypted backup, staged validation, swap, and automatic rollback.
set -Eeuo pipefail
umask 077
APP_DIR=${APP_DIR:-/opt/tron-energy-bot}
SERVICE_NAME=${SERVICE_NAME:-tron-energy}
ENV_FILE=${ENV_FILE:-/etc/tron-energy-bot.env}
RELEASE_ROOT=${RELEASE_ROOT:-/opt/tron-energy-releases}
[[ $EUID -eq 0 ]] || { echo '请使用 root 执行' >&2; exit 1; }
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '应用目录或环境文件不存在' >&2; exit 1; }
[[ -f package.json && -f scripts/backup.sh && -f scripts/ops-monitor.sh ]] || { echo '请在 V3.4 项目根目录执行' >&2; exit 1; }
command -v systemctl >/dev/null || { echo '需要 systemd' >&2; exit 1; }
command -v rsync >/dev/null || { echo '缺少 rsync' >&2; exit 1; }
command -v apt-get >/dev/null || { echo '此脚本面向 Debian/Ubuntu' >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
: "${AGE_RECIPIENT:?请先配置 AGE_RECIPIENT}"
: "${AGE_IDENTITY_FILE:?请先配置 AGE_IDENTITY_FILE}"
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo 'age 私钥不可读' >&2; exit 1; }
command -v age-keygen >/dev/null || { echo '缺少 age-keygen；请先安装 age' >&2; exit 1; }
[[ "$(age-keygen -y "$AGE_IDENTITY_FILE")" == "$AGE_RECIPIENT" ]] || { echo 'age 公钥与私钥不匹配' >&2; exit 1; }

DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y age curl gzip tar rsync python3
if [[ -n "${RCLONE_REMOTE:-}" ]]; then DEBIAN_FRONTEND=noninteractive apt-get install -y rclone; fi

# Back up the currently deployed application, DB and environment with age encryption.
APP_DIR="$APP_DIR" ENV_FILE="$ENV_FILE" ./scripts/backup.sh
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/tron-energy-bot}
LATEST=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[[ -n "$LATEST" ]] || { echo '找不到加密备份' >&2; exit 1; }
ENV_FILE="$ENV_FILE" ./scripts/verify-backup.sh "$LATEST"

STAMP=$(date +%Y%m%d-%H%M%S)
STAGE="$RELEASE_ROOT/v3.4-$STAMP"
PREVIOUS="$RELEASE_ROOT/previous-$STAMP"
mkdir -p "$RELEASE_ROOT"
chmod 700 "$RELEASE_ROOT"
[[ ! -e "$STAGE" && ! -e "$PREVIOUS" ]] || { echo '发布目录冲突，请重试' >&2; exit 1; }
rsync -a --delete --exclude=node_modules --exclude=.git ./ "$STAGE/"
chown -R tronbot:tronbot "$STAGE" 2>/dev/null || true

# Validate staged release before stopping the live service.
cd "$STAGE"
npm install --omit=dev
npm run check
npm test
# Apply legacy compatibility migrations, then the additive/idempotent V4 migration.
# V4 is schema-verified before the live service is stopped or the release is swapped.
node scripts/migrate-v3.1.js
node scripts/migrate-v3.3.js
node scripts/apply-v4-migration.js

SWAPPED=0
WAS_ACTIVE=0
if systemctl is-active --quiet "$SERVICE_NAME"; then WAS_ACTIVE=1; fi
rollback() {
  rc=$?
  trap - ERR EXIT
  if (( SWAPPED == 1 )); then
    echo "升级阶段失败，正在回滚到旧版本…" >&2
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if [[ -d "$APP_DIR" ]]; then mv "$APP_DIR" "$RELEASE_ROOT/failed-$STAMP" 2>/dev/null || true; fi
    if [[ -d "$PREVIOUS" ]]; then mv "$PREVIOUS" "$APP_DIR"; fi
    if (( WAS_ACTIVE == 1 )); then systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true; fi
    echo "旧版本已尝试恢复；失败版本保留在 $RELEASE_ROOT/failed-$STAMP" >&2
  fi
  exit "$rc"
}
trap rollback ERR
trap 'rc=$?; if (( rc != 0 )); then rollback; fi' EXIT

systemctl stop "$SERVICE_NAME"
mv "$APP_DIR" "$PREVIOUS"
SWAPPED=1
mv "$STAGE" "$APP_DIR"
chown -R tronbot:tronbot "$APP_DIR" 2>/dev/null || true
install -o root -g root -m 0644 "$APP_DIR/deploy/systemd/tron-energy-backup.service" /etc/systemd/system/tron-energy-backup.service
install -o root -g root -m 0644 "$APP_DIR/deploy/systemd/tron-energy-backup.timer" /etc/systemd/system/tron-energy-backup.timer
install -o root -g root -m 0644 "$APP_DIR/deploy/systemd/tron-energy-ops-monitor.service" /etc/systemd/system/tron-energy-ops-monitor.service
install -o root -g root -m 0644 "$APP_DIR/deploy/systemd/tron-energy-ops-monitor.timer" /etc/systemd/system/tron-energy-ops-monitor.timer
install -d -o root -g root -m 0700 /var/lib/tron-energy-bot
systemctl daemon-reload
systemctl enable --now tron-energy-backup.timer
systemctl enable --now tron-energy-ops-monitor.timer
systemctl start "$SERVICE_NAME"
for i in {1..15}; do
  if curl -fsS http://127.0.0.1:3080/health >/tmp/tron-energy-health-v3.0.json; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:3080/health >/dev/null
"$APP_DIR/scripts/ops-monitor.sh"
SWAPPED=0
trap - ERR EXIT
# Keep the prior release for manual rollback; do not remove it automatically.
printf '\nV3.4 upgrade completed. Encrypted backup: %s\nPrevious release retained at: %s\n' "$LATEST" "$PREVIOUS"
