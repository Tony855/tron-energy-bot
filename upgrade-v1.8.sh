#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "请使用 sudo bash upgrade-v1.8.sh"; exit 1; }
[[ -f package.json && -f src/chainAlerts.js && -f sql/migrate_v1_8.sql ]] || { echo "请在 V1.8 项目根目录执行"; exit 1; }
APP_DIR=/opt/tron-energy-bot
ENV_FILE=/etc/tron-energy-bot.env
STAMP=$(date +%Y%m%d%H%M%S)
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo "找不到现有应用或环境文件，停止升级"; exit 1; }
BACKUP="/root/tron-energy-backup-v1.8-$STAMP"
mkdir -p "$BACKUP"
mysqldump --single-transaction tron_energy > "$BACKUP/tron_energy.sql"
cp -a "$ENV_FILE" "$BACKUP/tron-energy-bot.env"
cp -a "$APP_DIR" "$BACKUP/app"
apt-get update
apt-get install -y rsync
systemctl stop tron-energy
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R tronbot:tronbot "$APP_DIR"
runuser -u tronbot -- npm --prefix "$APP_DIR" install --omit=dev
mysql tron_energy < "$APP_DIR/sql/migrate_v1_8.sql"
systemctl start tron-energy
sleep 2
systemctl --no-pager --full status tron-energy
curl -fsS http://127.0.0.1:3080/health
echo
echo "升级完成。告警默认关闭。备份：$BACKUP"
echo "编辑 $ENV_FILE 配置 CHAIN_ALERTS_ENABLED=true 与 ADMIN_TELEGRAM_IDS 后，重启服务才会启用 Telegram 告警。"
