#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/tron-energy-bot
SERVICE_NAME=tron-energy
ENV_FILE=/etc/tron-energy-bot.env
[[ $EUID -eq 0 ]] || { echo '请使用 root 执行'; exit 1; }
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '应用目录或环境文件不存在'; exit 1; }
[[ -f package.json && -f scripts/backup.sh && -f scripts/ops-monitor.sh ]] || { echo '请在 V2.9 项目根目录执行'; exit 1; }
command -v systemctl >/dev/null || { echo '需要 systemd'; exit 1; }
command -v rsync >/dev/null || { echo '缺少 rsync'; exit 1; }
command -v apt-get >/dev/null || { echo '此升级脚本针对 Debian/Ubuntu'; exit 1; }
set -a; source "$ENV_FILE"; set +a
: "${AGE_RECIPIENT:?请先配置 AGE_RECIPIENT}"
: "${AGE_IDENTITY_FILE:?请先配置 AGE_IDENTITY_FILE}"
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo 'age 私钥不可读'; exit 1; }
[[ "$(age-keygen -y "$AGE_IDENTITY_FILE")" == "$AGE_RECIPIENT" ]] || { echo 'age 公钥与私钥不匹配'; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y age curl gzip tar rsync python3
if [[ -n "${RCLONE_REMOTE:-}" ]]; then DEBIAN_FRONTEND=noninteractive apt-get install -y rclone; fi
# Create and verify an encrypted pre-upgrade backup before replacing any application files.
APP_DIR="$APP_DIR" ENV_FILE="$ENV_FILE" ./scripts/backup.sh
LATEST=$(find "${BACKUP_ROOT:-/var/backups/tron-energy-bot}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[[ -n "$LATEST" ]] || { echo '找不到刚生成的加密备份'; exit 1; }
ENV_FILE="$ENV_FILE" ./scripts/verify-backup.sh "$LATEST"
STAMP=$(date +%Y%m%d-%H%M%S)
tar --exclude=node_modules --exclude=.git -czf "/root/tron-energy-app-before-v2.9-$STAMP.tar.gz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
chmod 600 "/root/tron-energy-app-before-v2.9-$STAMP.tar.gz"
systemctl stop "$SERVICE_NAME"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R tronbot:tronbot "$APP_DIR" 2>/dev/null || true
cd "$APP_DIR"
npm install --omit=dev
npm run check
npm test
install -o root -g root -m 0644 deploy/systemd/tron-energy-backup.service /etc/systemd/system/tron-energy-backup.service
install -o root -g root -m 0644 deploy/systemd/tron-energy-backup.timer /etc/systemd/system/tron-energy-backup.timer
install -o root -g root -m 0644 deploy/systemd/tron-energy-ops-monitor.service /etc/systemd/system/tron-energy-ops-monitor.service
install -o root -g root -m 0644 deploy/systemd/tron-energy-ops-monitor.timer /etc/systemd/system/tron-energy-ops-monitor.timer
install -d -o root -g root -m 0700 /var/lib/tron-energy-bot
systemctl daemon-reload
systemctl enable --now tron-energy-backup.timer
systemctl enable --now tron-energy-ops-monitor.timer
systemctl start "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"
curl -fsS http://127.0.0.1:3080/health
"$APP_DIR/scripts/ops-monitor.sh" || { echo '运维监控首次检查未通过，请检查告警和 systemd 日志' >&2; exit 1; }
printf '\nV2.9 upgraded. Encrypted backup: %s\n' "$LATEST"
