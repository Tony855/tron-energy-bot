#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/tron-energy-bot
DB_NAME=${DB_NAME:-tron_energy}
SERVICE_NAME=tron-energy
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/root/tron-energy-backup-v2.6-$STAMP"
[[ $EUID -eq 0 ]] || { echo '请使用 root 执行'; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "应用目录不存在：$APP_DIR"; exit 1; }
[[ -f .env.example && -f src/sharedLoginGuard.js && -f sql/migrate_v2_6.sql ]] || { echo '请在 V2.6 项目根目录执行'; exit 1; }
command -v mysqldump >/dev/null 2>&1 || { echo '缺少 mysqldump，停止升级'; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo '缺少 rsync，请先安装'; exit 1; }
mkdir -p "$BACKUP_DIR"
mysqldump --single-transaction "$DB_NAME" > "$BACKUP_DIR/database.sql"
cp -a /etc/tron-energy-bot.env "$BACKUP_DIR/env" 2>/dev/null || true
cp -a "$APP_DIR" "$BACKUP_DIR/app"
echo "备份完成：$BACKUP_DIR"
echo '注意：数据库迁移仅能执行一次。确认 admin_users.token_version 尚不存在。'
read -r -p '输入 MIGRATE-V2.6 继续数据库迁移：' CONFIRM
[[ "$CONFIRM" == 'MIGRATE-V2.6' ]] || { echo '已取消'; exit 1; }
mysql "$DB_NAME" < sql/migrate_v2_6.sql
systemctl stop "$SERVICE_NAME"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
cd "$APP_DIR"
chown -R tronbot:tronbot "$APP_DIR" 2>/dev/null || true
npm install --omit=dev
npm run check
systemctl start "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"
curl -fsS http://127.0.0.1:3080/health
printf '\n升级完成。备份：%s\n' "$BACKUP_DIR"
