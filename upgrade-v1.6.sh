#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "请使用 sudo bash upgrade-v1.6.sh"; exit 1; }
[[ -f package.json && -f src/chainAudit.js && -d src ]] || { echo "请在 V1.6 项目根目录执行"; exit 1; }
APP_DIR=/opt/tron-energy-bot
ENV_FILE=/etc/tron-energy-bot.env
STAMP=$(date +%Y%m%d%H%M%S)
[[ -d "$APP_DIR" ]] || { echo "找不到 $APP_DIR，不能作为升级操作"; exit 1; }
mkdir -p "/root/tron-energy-backup-$STAMP"
mysqldump tron_energy > "/root/tron-energy-backup-$STAMP/tron_energy.sql"
cp -a "$ENV_FILE" "/root/tron-energy-backup-$STAMP/tron-energy-bot.env"
cp -a "$APP_DIR" "/root/tron-energy-backup-$STAMP/app"
apt-get update
apt-get install -y rsync
systemctl stop tron-energy
# Preserve .env outside the app; replace app tree only after backup.
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R tronbot:tronbot "$APP_DIR"
runuser -u tronbot -- npm --prefix "$APP_DIR" install --omit=dev
systemctl start tron-energy
sleep 2
systemctl --no-pager --full status tron-energy
curl -fsS http://127.0.0.1:3080/health
echo
echo "升级完成。备份位于 /root/tron-energy-backup-$STAMP"
