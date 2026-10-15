#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 sudo bash upgrade-v1.9.sh'; exit 1; }
[[ -f package.json && -f src/financeAudit.js ]] || { echo '请在 V1.9 项目根目录执行'; exit 1; }
APP_DIR=/opt/tron-energy-bot
ENV_FILE=/etc/tron-energy-bot.env
STAMP=$(date +%Y%m%d%H%M%S)
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '找不到现有应用或环境文件，停止升级'; exit 1; }
BACKUP="/root/tron-energy-backup-v1.9-$STAMP"
mkdir -p "$BACKUP"
mysqldump --single-transaction tron_energy > "$BACKUP/tron_energy.sql"
cp -a "$ENV_FILE" "$BACKUP/tron-energy-bot.env"
cp -a "$APP_DIR" "$BACKUP/app"
apt-get update
apt-get install -y rsync
npm run check
npm test
systemctl stop tron-energy
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R tronbot:tronbot "$APP_DIR"
runuser -u tronbot -- npm --prefix "$APP_DIR" install --omit=dev
systemctl start tron-energy
sleep 2
systemctl --no-pager --full status tron-energy
curl -fsS http://127.0.0.1:3080/health
echo
echo "V1.9 升级完成。备份：$BACKUP"
