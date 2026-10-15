#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/tron-energy-bot
SERVICE_NAME=tron-energy
[[ $EUID -eq 0 ]] || { echo '请使用 root 执行'; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "应用目录不存在：$APP_DIR"; exit 1; }
[[ -f package.json && -f scripts/backup.sh && -f scripts/restore-drill.sh ]] || { echo '请在 V2.7 项目根目录执行'; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo '缺少 rsync，请先安装'; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo '需要 systemd'; exit 1; }
# Backup installed DB, env and application before replacing anything.
APP_DIR="$APP_DIR" ENV_FILE=/etc/tron-energy-bot.env ./scripts/backup.sh
STAMP=$(date +%Y%m%d-%H%M%S)
PREUPGRADE="/root/tron-energy-app-before-v2.7-$STAMP.tar.gz"
tar --exclude=node_modules --exclude=.git -czf "$PREUPGRADE" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
chmod 600 "$PREUPGRADE"
systemctl stop "$SERVICE_NAME"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R tronbot:tronbot "$APP_DIR" 2>/dev/null || true
cd "$APP_DIR"
npm install --omit=dev
npm run check
install -o root -g root -m 0644 deploy/systemd/tron-energy-backup.service /etc/systemd/system/tron-energy-backup.service
install -o root -g root -m 0644 deploy/systemd/tron-energy-backup.timer /etc/systemd/system/tron-energy-backup.timer
systemctl daemon-reload
systemctl enable --now tron-energy-backup.timer
systemctl start "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"
for i in $(seq 1 10); do if curl -fsS http://127.0.0.1:3080/health; then break; fi; sleep 2; done
curl -fsS http://127.0.0.1:3080/health
printf '\nV2.7 upgraded. Database backup and app archive saved; app archive: %s\n' "$PREUPGRADE"
echo 'No database migration was run. Backup is local and unencrypted; configure secure off-host copies.'
