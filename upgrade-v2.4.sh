#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 sudo bash upgrade-v2.4.sh'; exit 1; }
[[ -f package.json && -f src/loginGuard.js && -f test/loginGuard.test.js ]] || { echo '请在 V2.4 项目根目录执行'; exit 1; }
APP_DIR=/opt/tron-energy-bot
ENV_FILE=/etc/tron-energy-bot.env
SERVICE=tron-energy
DB_NAME=${DB_NAME:-tron_energy}
DB_USER_SERVICE=${DB_USER_SERVICE:-tronbot}
STAMP=$(date +%Y%m%d%H%M%S)
[[ -d "$APP_DIR" && -f "$ENV_FILE" ]] || { echo '找不到现有应用或环境文件，停止升级'; exit 1; }
BACKUP="/root/tron-energy-backup-v2.4-$STAMP"
mkdir -p "$BACKUP"
mysqldump --single-transaction "$DB_NAME" > "$BACKUP/$DB_NAME.sql"
cp -a "$ENV_FILE" "$BACKUP/tron-energy-bot.env"
cp -a "$APP_DIR" "$BACKUP/app"
echo '检查新版本语法和自动化测试...'
npm run check
npm test
# No DB migration in V2.4. Add optional login guard settings without overwriting existing values.
grep -q '^LOGIN_MAX_ATTEMPTS=' "$ENV_FILE" || echo 'LOGIN_MAX_ATTEMPTS=5' >> "$ENV_FILE"
grep -q '^LOGIN_WINDOW_MS=' "$ENV_FILE" || echo 'LOGIN_WINDOW_MS=900000' >> "$ENV_FILE"
grep -q '^LOGIN_LOCK_MS=' "$ENV_FILE" || echo 'LOGIN_LOCK_MS=900000' >> "$ENV_FILE"
systemctl stop "$SERVICE"
rsync -a --delete --exclude node_modules ./ "$APP_DIR/"
chown -R "$DB_USER_SERVICE":"$DB_USER_SERVICE" "$APP_DIR"
runuser -u "$DB_USER_SERVICE" -- npm --prefix "$APP_DIR" install --omit=dev
systemctl start "$SERVICE"
sleep 2
systemctl --no-pager --full status "$SERVICE"
curl -fsS http://127.0.0.1:3080/health
echo
echo "V2.4 升级完成。登录令牌有效期缩短为 30 分钟，升级后需要重新登录。备份：$BACKUP"
