#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 sudo bash upgrade-v2.2.sh'; exit 1; }
[[ -f package.json && -f src/money.js && -f src/ledger.js ]] || { echo '请在 V2.2 项目根目录执行'; exit 1; }
APP_DIR=/opt/tron-energy-bot
ENV_FILE=/etc/tron-energy-bot.env
SERVICE=tron-energy
DB_NAME=${DB_NAME:-tron_energy}
DB_USER_SERVICE=${DB_USER_SERVICE:-tronbot}
STAMP=$(date +%Y%m%d%H%M%S)
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '找不到现有应用或环境文件，停止升级'; exit 1; }
BACKUP="/root/tron-energy-backup-v2.2-$STAMP"
mkdir -p "$BACKUP"
echo "备份数据库到 $BACKUP/$DB_NAME.sql"
mysqldump --single-transaction "$DB_NAME" > "$BACKUP/$DB_NAME.sql"
cp -a "$ENV_FILE" "$BACKUP/tron-energy-bot.env"
cp -a "$APP_DIR" "$BACKUP/app"
echo '检查新版本语法和自动化测试...'
npm run check
npm test
echo '停止服务并更新程序...'
systemctl stop "$SERVICE"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R "$DB_USER_SERVICE":"$DB_USER_SERVICE" "$APP_DIR"
runuser -u "$DB_USER_SERVICE" -- npm --prefix "$APP_DIR" install --omit=dev
systemctl start "$SERVICE"
sleep 2
systemctl --no-pager --full status "$SERVICE"
curl -fsS http://127.0.0.1:3080/health
echo
echo "V2.2 升级完成。无需数据库迁移；备份：$BACKUP"
