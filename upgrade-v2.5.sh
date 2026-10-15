#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/tron-energy-bot
DB_NAME=${DB_NAME:-tron_energy}
SERVICE_NAME=tron-energy
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/root/tron-energy-backup-v2.5-$STAMP"
[[ $EUID -eq 0 ]] || { echo '请使用 root 执行'; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "应用目录不存在：$APP_DIR"; exit 1; }
[[ -f .env.example && -f src/rbac.js && -f sql/migrate_v2_5.sql ]] || { echo '请在 V2.5 项目根目录执行'; exit 1; }
mkdir -p "$BACKUP_DIR"
if command -v mysqldump >/dev/null 2>&1; then mysqldump --single-transaction "$DB_NAME" > "$BACKUP_DIR/database.sql"; else echo '缺少 mysqldump，停止升级'; exit 1; fi
cp -a /etc/tron-energy-bot.env "$BACKUP_DIR/env" 2>/dev/null || true
cp -a "$APP_DIR" "$BACKUP_DIR/app"
echo "备份完成：$BACKUP_DIR"
read -r -p '输入 MIGRATE-V2.5 继续数据库迁移：' CONFIRM
[[ "$CONFIRM" == 'MIGRATE-V2.5' ]] || { echo '已取消'; exit 1; }
mysql "$DB_NAME" < sql/migrate_v2_5.sql
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
