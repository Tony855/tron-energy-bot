#!/usr/bin/env bash
# TRON Energy Bot fresh installer for Debian/Ubuntu (systemd + MySQL + Node.js 22+).
# Safe by default: refuses to overwrite an existing deployment/config/database account.
set -Eeuo pipefail
umask 077

# ------------------ 参数解析 ------------------
DRY_RUN=0
UNATTENDED=0

print_help() {
  cat <<'HELP'
TRON Energy Bot 一键安装脚本

用法: sudo bash install.sh [选项]

选项:
  -h, --help          显示帮助
  -V, --version       显示版本
  -y, --yes           非交互模式
  -n, --dry-run       演练模式（不修改系统）
  --app-dir=PATH      应用目录（默认 /opt/tron-energy-bot）
  --env-file=PATH     环境文件（默认 /etc/tron-energy-bot.env）

非交互模式可用环境变量:
  BOT_TOKEN, ADMIN_USERNAME, ADMIN_TELEGRAM_IDS, DOMAIN,
  TRONGRID_API_KEY, USDT_CONTRACT, MIN_DEPOSIT,
  REFERRAL_PERCENT, EVENT_SECRET
HELP
}

for _arg in "$@"; do
  case "$_arg" in
    -h|--help)    print_help; exit 0 ;;
    -V|--version) printf 'tron-energy-bot installer %s\n' "$(cat VERSION 2>/dev/null || echo unknown)"; exit 0 ;;
    -y|--yes)     UNATTENDED=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    --app-dir=*)  APP_DIR="${_arg#--app-dir=}" ;;
    --env-file=*) ENV_FILE="${_arg#--env-file=}" ;;
    *) printf '未知参数: %s（--help 查看用法）\n' "$_arg" >&2; exit 2 ;;
  esac
done

# ------------------ 安装日志 ------------------
INSTALL_LOG="${INSTALL_LOG:-/var/log/tron-energy-install-$(date +%Y%m%d-%H%M%S).log}"
if [[ -w /var/log ]]; then
  exec > >(tee -a "$INSTALL_LOG") 2>&1
fi

# ------------------ 命令预检 ------------------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[ERROR] 缺少命令: %s（apt-get install -y %s）\n' "$1" "${2:-$1}" >&2; exit 1; }
}

APP_NAME="tron-energy"
APP_DIR="${APP_DIR:-/opt/tron-energy-bot}"
ENV_FILE="${ENV_FILE:-/etc/tron-energy-bot.env}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
DB_NAME="tron_energy"
DB_USER="tronbot"
MIN_NODE_MAJOR=22

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info(){ printf "${GREEN}[INFO]${NC} %s\n" "$*"; }
warn(){ printf "${YELLOW}[WARN]${NC} %s\n" "$*" >&2; }
die(){ printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; exit 1; }
trap 'rc=$?; printf "
[ERROR] 安装失败（退出码 %s，第 %s 行）
" "$rc" "$LINENO" >&2; [[ -n "${INSTALL_LOG:-}" ]] && printf "[ERROR] 完整日志: %s
" "$INSTALL_LOG" >&2; printf "[ERROR] 如需重新安装，请手动清理：
  systemctl stop %s 2>/dev/null || true
  userdel -r %s 2>/dev/null || true
  rm -rf %s %s %s
" "$APP_NAME" "$DB_USER" "$APP_DIR" "$ENV_FILE" "$SERVICE_FILE" >&2; exit "$rc"' ERR

[[ $EUID -eq 0 ]] || die "请使用 root 执行：sudo bash install.sh"
for _cmd in curl gpg openssl python3 tar gzip rsync sed awk grep; do
  require_cmd "$_cmd" "$_cmd"
done
[[ -f package.json && -f sql/schema.sql && -d src ]] || die "请在解压后的项目根目录运行 install.sh。"
[[ -f /etc/os-release ]] || die "无法识别操作系统。"
. /etc/os-release
[[ "${ID:-}" == debian || "${ID:-}" == ubuntu || " ${ID_LIKE:-} " == *debian* ]] || die "仅支持 Debian/Ubuntu 系统。"
command -v systemctl >/dev/null || die "系统未使用 systemd，无法安装服务。"
[[ ! -e "$ENV_FILE" ]] || die "发现已有配置 $ENV_FILE。为避免覆盖现有密钥，请使用对应版本 upgrade-v*.sh 或先人工备份处理。"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -e "$APP_DIR" ]] && find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  APP_REAL="$(realpath -m "$APP_DIR")"
  SOURCE_REAL="$(realpath -m "$SOURCE_DIR")"
  if [[ "$APP_REAL" != "$SOURCE_REAL" ]]; then
    die "应用目录 $APP_DIR 已存在且非空。为避免覆盖旧版本，请使用升级脚本。"
  fi
fi
[[ ! -e "$SERVICE_FILE" ]] || die "systemd 服务 $SERVICE_FILE 已存在；请使用升级脚本。"
# Refuse a fresh install if the database account already exists.
# Never reset an existing database account password automatically.
if command -v mysql >/dev/null 2>&1 &&
   systemctl is-active --quiet mysql 2>/dev/null; then
  if mysql --protocol=socket -Nse     "SELECT COUNT(*) FROM mysql.user WHERE User='${DB_USER}' AND Host='127.0.0.1';"     2>/dev/null | grep -qx '1'; then
    die "数据库账号 ${DB_USER}@127.0.0.1 已存在。为避免影响现有服务，请勿重复全新安装；请使用对应版本升级脚本。"
  fi
fi


# Interactive prompts can be preseeded with environment variables for unattended installs.
ask(){
  local var="$1" label="$2" default="${3:-}" value="${!1:-}"
  if [[ -z "$value" ]]; then
    if (( UNATTENDED )); then
      [[ -n "$default" ]] || { printf '[ERROR] 非交互模式（-y）缺少必填变量 %s，且无默认值\n' "$var" >&2; exit 1; }
      value="$default"
    elif [[ -n "$default" ]]; then
      read -r -p "$label [$default]: " value || true
      value="${value:-$default}"
    else
      read -r -p "$label: " value || true
    fi
  fi
  printf -v "$var" '%s' "$value"
}
ask_secret(){ local var="$1" label="$2" value="${!1:-}"; if [[ -z "$value" ]]; then read -r -s -p "$label: " value || true; echo; fi; printf -v "$var" '%s' "$value"; }

ask BOT_TOKEN "Telegram Bot Token（从 @BotFather 获取）"
[[ -n "$BOT_TOKEN" && "$BOT_TOKEN" == *:* ]] || die "BOT_TOKEN 格式不正确；请检查 @BotFather 提供的 token。"
ask ADMIN_USERNAME "网页管理员用户名" "admin"
[[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_.-]{3,64}$ ]] || die "管理员用户名仅允许 3-64 位英文字母、数字、点、下划线和连字符。"
# Generate strong random passwords automatically. Hex characters are SQL/shell safe.
ADMIN_PASSWORD="$(openssl rand -hex 16)"  # 32 characters, 128 bits of entropy
DB_PASSWORD="$(openssl rand -hex 24)"     # 48 characters, 192 bits of entropy
ask ADMIN_TELEGRAM_IDS "管理员 Telegram 数字 ID（多个用逗号分隔，可留空）" ""
if [[ -n "$ADMIN_TELEGRAM_IDS" && ! "$ADMIN_TELEGRAM_IDS" =~ ^-?[0-9]+(,-?[0-9]+)*$ ]]; then die "ADMIN_TELEGRAM_IDS 格式错误；请填写数字 ID，以逗号分隔。"; fi
ask DOMAIN "后台域名（留空则仅本机访问）" ""
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then die "域名格式不正确。请只填写主机名，不要带协议、端口或路径。"; fi
ask TRONGRID_API_KEY "TRONGrid API Key（可留空）" ""
ask USDT_CONTRACT "TRON 主网 USDT 合约" "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
[[ "$USDT_CONTRACT" =~ ^T[1-9A-HJ-NP-Za-km-z]{33}$ ]] || die "USDT 合约地址格式不正确。"
ask MIN_DEPOSIT "最低充值识别金额 USDT" "1"
[[ "$MIN_DEPOSIT" =~ ^[0-9]+([.][0-9]{1,6})?$ ]] || die "最低充值金额必须为非负数字，最多 6 位小数。"
ask REFERRAL_PERCENT "邀请返佣比例（百分比）" "3"
[[ "$REFERRAL_PERCENT" =~ ^([0-9]|[1-9][0-9]|100)([.][0-9]{1,2})?$ ]] || die "返佣比例必须在 0-100 之间。"
ask EVENT_SECRET "第三方 TRON 事件服务 HMAC 密钥（留空自动生成）" ""
if [[ -z "$EVENT_SECRET" ]]; then EVENT_SECRET="$(openssl rand -hex 32)"; fi
[[ ${#EVENT_SECRET} -ge 32 ]] || die "事件 HMAC 密钥至少 32 个字符。"

if (( DRY_RUN )); then
  info "演练模式（--dry-run）：以下步骤不会真正执行。"
  info "APP_DIR=$APP_DIR"
  info "ENV_FILE=$ENV_FILE"
  info "SERVICE=$APP_NAME"
  info "DB_NAME=$DB_NAME  DB_USER=$DB_USER"
  info "DOMAIN=${DOMAIN:-（未设置）}"
  info "将执行：apt-get install / useradd / npm install / mysql schema / systemd unit"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
info "安装系统依赖（MySQL、Nginx、Node.js、age、rsync、curl）..."
apt_wait() {
  local waited=0
  while pgrep -x apt-get >/dev/null 2>&1 || pgrep -x apt >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; do
    if (( waited >= 120 )); then die "apt lock 超时（120 秒）"; fi
    sleep 3; waited=$(( waited + 3 ))
  done
}
apt_wait
apt-get update
apt_wait
apt-get install -y --no-install-recommends ca-certificates curl gnupg nginx mysql-server openssl python3 age rsync
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt "$MIN_NODE_MAJOR" ]]; then
  info "配置 NodeSource Node.js 22 仓库..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL --retry 3 --retry-delay 2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg || die "无法获取 NodeSource GPG key"
  [[ -s /etc/apt/keyrings/nodesource.gpg ]] || die "NodeSource GPG key 为空"
  gpg --list-packets /etc/apt/keyrings/nodesource.gpg >/dev/null 2>&1 || die "NodeSource GPG key 格式无效"
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt_wait
  apt-get update
  apt_wait
  apt-get install -y --no-install-recommends nodejs
fi
node_major="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
[[ "$node_major" -ge "$MIN_NODE_MAJOR" ]] || die "需要 Node.js 22+，当前为 $(node -v)。"
info "运行环境：Node $(node -v)，npm $(npm -v)"

# Copy source without VCS state or host node_modules. Refuse accidental self-copy.
install -d -m 0755 "$APP_DIR"
if [[ "$(realpath -m "$SOURCE_DIR")" != "$(realpath -m "$APP_DIR")" ]]; then
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='*.zip' "$SOURCE_DIR/" "$APP_DIR/"
fi
id tronbot >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin tronbot
chown -R tronbot:tronbot "$APP_DIR"
info "安装生产依赖..."
runuser -u tronbot -- npm --prefix "$APP_DIR" install --omit=dev --no-audit --no-fund
runuser -u tronbot -- npm --prefix "$APP_DIR" run check
runuser -u tronbot -- npm --prefix "$APP_DIR" test

info "生成安全配置文件..."
ADMIN_HASH="$(node -e "process.stdout.write(require('$APP_DIR/node_modules/bcryptjs').hashSync(process.argv[1], 12))" "$ADMIN_PASSWORD")"
JWT_SECRET="$(openssl rand -hex 48)"
PUBLIC_URL="http://127.0.0.1:3080"; [[ -z "$DOMAIN" ]] || PUBLIC_URL="https://$DOMAIN"
# Python JSON string escaping is compatible with dotenv quoted values; do not echo secrets to logs.
python3 - "$ENV_FILE" "$BOT_TOKEN" "$DB_PASSWORD" "$ADMIN_USERNAME" "$ADMIN_HASH" "$JWT_SECRET" "$PUBLIC_URL" "$TRONGRID_API_KEY" "$USDT_CONTRACT" "$MIN_DEPOSIT" "$REFERRAL_PERCENT" "$ADMIN_TELEGRAM_IDS" "$EVENT_SECRET" <<'PY'
import json, os, sys
(path, bot, dbpw, admin, admin_hash, jwt, public_url, api_key, contract, min_deposit, referral, admin_ids, event_secret) = sys.argv[1:]
def q(v): return json.dumps(v, ensure_ascii=False)
lines = [
 f"BOT_TOKEN={q(bot)}", "DB_HOST=127.0.0.1", "DB_PORT=3306", "DB_NAME=tron_energy", "DB_USER=tronbot", f"DB_PASSWORD={q(dbpw)}",
 "HOST=127.0.0.1", "PORT=3080", f"PUBLIC_BASE_URL={q(public_url)}", f"JWT_SECRET={q(jwt)}", f"ADMIN_USERNAME={q(admin)}", f"ADMIN_PASSWORD_HASH={q(admin_hash)}",
 "TRON_API_BASE=https://api.trongrid.io", f"TRONGRID_API_KEY={q(api_key)}", f"TRON_USDT_CONTRACT={q(contract)}", "TRON_USDT_DECIMALS=6", "TRON_CONFIRMATIONS_REQUIRED=19",
 f"MIN_DEPOSIT={q(min_deposit)}", f"REFERRAL_COMMISSION_PERCENT={q(referral)}", f"ADMIN_TELEGRAM_IDS={q(admin_ids)}", "ENERGY_PROVIDER_MODE=disabled", "AUTO_CREDIT_CONFIRMED=false",
 "TRON_EVENT_ONLY=true", f"TRON_EVENT_WEBHOOK_SECRET={q(event_secret)}", "TRON_POLL_SECONDS=60", "BACKUP_MAX_AGE_HOURS=30", "DISK_WARN_PERCENT=85",
 "AGE_IDENTITY_FILE=/root/.config/tron-energy-bot/age-identity.txt", "BACKUP_ROOT=/var/backups/tron-energy-bot", "RETENTION_DAYS=14"
]
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f: f.write("\n".join(lines) + "\n")
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
chown root:root "$ENV_FILE"

info "初始化 MySQL（使用本机 root socket 认证）..."
systemctl enable --now mysql
mysql --protocol=socket < "$APP_DIR/sql/schema.sql"

# Auto-apply migrations (安全地执行所有升级补丁)
info "正在应用数据库升级补丁..."
for migration in "$APP_DIR"/sql/migrate_*.sql; do
    if [ -f "$migration" ]; then
        migration_name="$(basename "$migration")"
        info "  -> 执行: $migration_name"
        # Historical migrations are best-effort because the fresh schema already
        # contains some later columns/indexes. Always select the application DB:
        # migrations that use DATABASE() otherwise create no tables or fail.
        if [[ "$migration_name" == "migrate_v4_durable_queue.sql" ]]; then
            mysql --protocol=socket "$DB_NAME" < "$migration" || die "V4 durable queue migration failed; refusing to start an incomplete installation."
        else
            mysql --protocol=socket "$DB_NAME" < "$migration" || warn "历史迁移 $migration_name 未执行（可能已由最新 schema 覆盖）；请检查日志及最终 Schema Guard。"
        fi
    fi
done

# Verify the V4 schema explicitly before creating credentials or starting services.
V4_TABLE_COUNT="$(mysql --protocol=socket "$DB_NAME" -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('background_jobs','event_inbox','event_outbox','energy_orders')")"
[[ "$V4_TABLE_COUNT" == "4" ]] || die "V4 durable queue tables are incomplete ($V4_TABLE_COUNT/4)."
V4_STATUS_TYPE="$(mysql --protocol=socket "$DB_NAME" -Nse "SELECT column_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='energy_orders' AND column_name='status' LIMIT 1")"
[[ "$V4_STATUS_TYPE" == *submission_unknown* && "$V4_STATUS_TYPE" == *cancelled* ]] || die "energy_orders.status is missing required V4 states."

# Password charset is restricted above, so SQL interpolation cannot inject statements.
mysql --protocol=socket <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON ${DB_NAME}.* TO '${DB_USER}'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
# Verify application credentials before enabling the service.
MYSQL_PWD="$DB_PASSWORD" mysql --protocol=tcp -h 127.0.0.1 -u "$DB_USER" "$DB_NAME" -Nse 'SELECT 1' | grep -qx 1 || die "应用数据库账号连接失败。"

info "配置 systemd 服务..."
cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=TRON Energy Telegram Bot
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=tronbot
Group=tronbot
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/src/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$SERVICE_FILE"
systemd-analyze verify "$SERVICE_FILE" >/dev/null 2>&1 || die "systemd unit 校验失败：$SERVICE_FILE"

if [[ -n "$DOMAIN" ]]; then
  info "配置 Nginx（HTTP 反代；证书需另行申请）..."
  cat > "/etc/nginx/sites-available/${APP_NAME}" <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 75s;
    }
}
NGINX
  ln -sfn "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
  nginx -t
  systemctl enable --now nginx
fi

# Set up age identity for future encrypted backups. Private key is root-only.
install -d -m 0700 /root/.config/tron-energy-bot
if [[ ! -e /root/.config/tron-energy-bot/age-identity.txt ]]; then age-keygen -o /root/.config/tron-energy-bot/age-identity.txt >/dev/null 2>&1; fi
chmod 0600 /root/.config/tron-energy-bot/age-identity.txt
AGE_RECIPIENT="$(age-keygen -y /root/.config/tron-energy-bot/age-identity.txt)"
python3 - "$ENV_FILE" "$AGE_RECIPIENT" <<'PY'
import json, os, sys, tempfile
p, recipient = sys.argv[1:]
with open(p, encoding="utf-8") as f:
    lines = [line for line in f if not line.startswith("AGE_RECIPIENT=")]
lines.append("AGE_RECIPIENT=" + json.dumps(recipient) + "\n")
fd, tmp = tempfile.mkstemp(prefix=".tron-energy-env-", dir=os.path.dirname(p))
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.writelines(lines)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)
    os.chmod(p, 0o600)
except BaseException:
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    raise
PY
chmod 0600 "$ENV_FILE"
install -d -o root -g root -m 0700 /var/backups/tron-energy-bot /var/lib/tron-energy-bot
chown -R tronbot:tronbot "$APP_DIR"

# Enable backup/ops timers if units are present in this release.
for unit in tron-energy-backup.service tron-energy-backup.timer tron-energy-ops-monitor.service tron-energy-ops-monitor.timer; do
  if [[ -f "$APP_DIR/deploy/systemd/$unit" ]]; then install -o root -g root -m 0644 "$APP_DIR/deploy/systemd/$unit" "/etc/systemd/system/$unit"; fi
done
systemctl daemon-reload
for unit in tron-energy-backup.timer tron-energy-ops-monitor.timer; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then
    systemctl enable --now "$unit"
  else
    warn "未安装 $unit，跳过该定时器。"
  fi
done
systemctl enable --now "$APP_NAME"

info "等待健康检查..."
healthy=0
_elapsed=0; _delay=1
while (( _elapsed < 60 )); do
  if curl --connect-timeout 2 --max-time 4 -fsS http://127.0.0.1:3080/health >/tmp/tron-energy-install-health.json; then healthy=1; break; fi
  sleep "$_delay"
  _elapsed=$(( _elapsed + _delay ))
  _delay=$(( _delay < 8 ? _delay * 2 : 8 ))
done
if (( healthy != 1 )); then
  journalctl -u "$APP_NAME" -n 80 --no-pager >&2 || true
  die "服务未通过健康检查。服务已保留以便排查；查看 journalctl -u $APP_NAME。"
fi

# Save credentials root-only so they remain recoverable if terminal output is lost.
CREDENTIALS_FILE="/root/tron-energy-bot-credentials.txt"
if [[ -e "$CREDENTIALS_FILE" ]]; then
  mv "$CREDENTIALS_FILE" "${CREDENTIALS_FILE}.old-$(date +%Y%m%d-%H%M%S)"
  warn "已存在旧凭据文件，已重命名为 .old-<时间戳>"
fi
cat > "$CREDENTIALS_FILE" <<CREDS
TRON Energy Bot 安装凭据
生成时间：$(date -Is)
后台管理员用户名：$ADMIN_USERNAME
后台管理员密码：$ADMIN_PASSWORD
MySQL 数据库名：$DB_NAME
MySQL 数据库用户：$DB_USER
MySQL 数据库密码：$DB_PASSWORD
后台地址：$PUBLIC_URL
环境配置文件：$ENV_FILE
注意：请立即复制并妥善保存；不要发送给他人或上传到公开位置。
CREDS
chmod 0600 "$CREDENTIALS_FILE"
chown root:root "$CREDENTIALS_FILE"

printf '\n========== 安装完成 =========='
printf '\n服务状态：systemctl status %s --no-pager' "$APP_NAME"
printf '\n实时日志：journalctl -u %s -f' "$APP_NAME"
printf '\n配置文件：%s（root-only）' "$ENV_FILE"
printf '\n项目目录：%s' "$APP_DIR"
printf '\n健康检查：'; cat /tmp/tron-energy-install-health.json
printf '\n========== 自动生成的登录凭据 =========='
printf '\n后台管理员用户名：%s' "$ADMIN_USERNAME"
printf '\n后台管理员密码：%s' "$ADMIN_PASSWORD"
printf '\nMySQL 数据库名：%s' "$DB_NAME"
printf '\nMySQL 数据库用户：%s' "$DB_USER"
printf '\nMySQL 数据库密码：%s' "$DB_PASSWORD"
printf '\n凭据文件：%s（权限 600，仅 root 可读）\n' "$CREDENTIALS_FILE"
printf '\n事件 Webhook：POST /api/events/tron；签名头 x-tron-signature: sha256=<HMAC-SHA256(raw body, secret)>\n'
printf '事件密钥已保存至 %s；请从该 root-only 文件安全读取并配置到第三方事件供应商。\n' "$ENV_FILE"
printf '下一步：将域名 A 记录指向服务器后，安装 certbot 并为 Nginx 配置 HTTPS。\n'
warn "请立即保存上方随机密码。若遗失，可使用 root 读取 $CREDENTIALS_FILE。"

printf "
========== 安装后建议 ==========
"
printf "1. 防火墙：如启用 ufw，执行 ufw allow 80,443/tcp && ufw reload
"
if [[ -n "\$DOMAIN" ]]; then
  printf "2. HTTPS：apt install -y certbot python3-certbot-nginx && certbot --nginx -d %s
" "\$DOMAIN"
else
  printf "2. HTTPS：未配置域名；如需公网访问，请先设置 DNS 并在 install.sh 输入域名
"
fi
printf "3. 事件源：将 %s 中的 TRON_EVENT_WEBHOOK_SECRET 配置到第三方 TRON 事件服务
" "\$ENV_FILE"
printf "4. 备份：systemctl status tron-energy-backup.timer
"
printf "5. 监控：systemctl status tron-energy-ops-monitor.timer
"
warn "事件模式已启用，但 TronGrid 公共 API 不会主动推送事件。必须配置支持 TRON 主网事件 Webhook 的第三方服务，否则无法自动发现新交易。"
warn "能量供应商未接入，自动入账保持关闭。请勿在完成主网联调前开放真实资金流程。"
