#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/tron-energy-bot
SERVICE_NAME=tron-energy
ENV_FILE=/etc/tron-energy-bot.env
[[ $EUID -eq 0 ]] || { echo '请使用 root 执行'; exit 1; }
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '应用目录或环境文件不存在'; exit 1; }
[[ -f package.json && -f scripts/backup.sh && -f scripts/verify-backup.sh && -f scripts/restore-drill.sh ]] || { echo '请在 V2.8 项目根目录执行'; exit 1; }
command -v systemctl >/dev/null || { echo '需要 systemd'; exit 1; }
command -v rsync >/dev/null || { echo '缺少 rsync'; exit 1; }
command -v apt-get >/dev/null || { echo '此升级脚本针对 Debian/Ubuntu'; exit 1; }
# Install required encryption tooling before any backup is attempted.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y age curl gzip tar rsync python3
# Require the encryption setup before touching the running application.
set -a; source "$ENV_FILE"; set +a
: "${AGE_RECIPIENT:?请先在 /etc/tron-energy-bot.env 配置 AGE_RECIPIENT}"
: "${AGE_IDENTITY_FILE:?请先配置 AGE_IDENTITY_FILE}"
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo "AGE identity 不可读：$AGE_IDENTITY_FILE"; exit 1; }
[[ "$(age-keygen -y "$AGE_IDENTITY_FILE")" == "$AGE_RECIPIENT" ]] || { echo 'AGE_RECIPIENT 与 AGE_IDENTITY_FILE 不匹配'; exit 1; }
if [[ -n "${RCLONE_REMOTE:-}" ]]; then DEBIAN_FRONTEND=noninteractive apt-get install -y rclone; fi
# Make a verified encrypted pre-upgrade backup using the V2.8 script.
APP_DIR="$APP_DIR" ENV_FILE="$ENV_FILE" ./scripts/backup.sh
LATEST=$(find "${BACKUP_ROOT:-/var/backups/tron-energy-bot}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[[ -n "$LATEST" ]] || { echo '找不到刚生成的备份'; exit 1; }
ENV_FILE="$ENV_FILE" ./scripts/verify-backup.sh "$LATEST"
STAMP=$(date +%Y%m%d-%H%M%S)
PREUPGRADE="/root/tron-energy-app-before-v2.8-$STAMP.tar.gz"
tar --exclude=node_modules --exclude=.git -czf "$PREUPGRADE" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
chmod 600 "$PREUPGRADE"
systemctl stop "$SERVICE_NAME"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R tronbot:tronbot "$APP_DIR" 2>/dev/null || true
cd "$APP_DIR"
npm install --omit=dev
npm run check
npm test
install -o root -g root -m 0644 deploy/systemd/tron-energy-backup.service /etc/systemd/system/tron-energy-backup.service
install -o root -g root -m 0644 deploy/systemd/tron-energy-backup.timer /etc/systemd/system/tron-energy-backup.timer
systemctl daemon-reload
systemctl enable --now tron-energy-backup.timer
systemctl start "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"
curl -fsS http://127.0.0.1:3080/health
printf '\nV2.8 upgraded. Encrypted backup: %s; app archive: %s\n' "$LATEST" "$PREUPGRADE"
echo 'Confirm remote backup replication separately if RCLONE_REMOTE is configured.'
