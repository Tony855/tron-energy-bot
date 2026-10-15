#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 sudo bash upgrade-v2.3.sh'; exit 1; }
[[ -f package.json && -f src/chainDepositVerify.js && -f sql/migrate_v2_3.sql ]] || { echo '请在 V2.3 项目根目录执行'; exit 1; }
APP_DIR=/opt/tron-energy-bot
ENV_FILE=/etc/tron-energy-bot.env
SERVICE=tron-energy
DB_NAME=${DB_NAME:-tron_energy}
DB_USER_SERVICE=${DB_USER_SERVICE:-tronbot}
STAMP=$(date +%Y%m%d%H%M%S)
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '找不到现有应用或环境文件，停止升级'; exit 1; }
BACKUP="/root/tron-energy-backup-v2.3-$STAMP"
mkdir -p "$BACKUP"
mysqldump --single-transaction "$DB_NAME" > "$BACKUP/$DB_NAME.sql"
cp -a "$ENV_FILE" "$BACKUP/tron-energy-bot.env"
cp -a "$APP_DIR" "$BACKUP/app"
echo '检查新版本语法和自动化测试...'
npm run check
npm test
printf '\n即将执行一次性数据库迁移。请确认此前未执行过 sql/migrate_v2_3.sql。\n'
read -r -p '输入 MIGRATE-V2.3 继续：' CONFIRM
[[ "$CONFIRM" == 'MIGRATE-V2.3' ]] || { echo '已取消；备份保留在：'"$BACKUP"; exit 1; }
mysql "$DB_NAME" < sql/migrate_v2_3.sql
systemctl stop "$SERVICE"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R "$DB_USER_SERVICE":"$DB_USER_SERVICE" "$APP_DIR"
runuser -u "$DB_USER_SERVICE" -- npm --prefix "$APP_DIR" install --omit=dev
systemctl start "$SERVICE"
sleep 2
systemctl --no-pager --full status "$SERVICE"
curl -fsS http://127.0.0.1:3080/health
echo
echo "V2.3 升级完成。备份：$BACKUP"
