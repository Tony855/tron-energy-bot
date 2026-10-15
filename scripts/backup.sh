#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ENV_FILE=${ENV_FILE:-/etc/tron-energy-bot.env}
APP_DIR=${APP_DIR:-/opt/tron-energy-bot}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/tron-energy-bot}
RETENTION_DAYS=${RETENTION_DAYS:-14}
OUT=""
notify_admins() {
  local msg="$1" token ids id
  token=${BOT_TOKEN:-}; ids=${ADMIN_TELEGRAM_IDS:-}
  [[ -n "$token" && -n "$ids" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  IFS=',' read -ra arr <<< "$ids"
  for id in "${arr[@]}"; do
    id=$(printf '%s' "$id" | tr -d '[:space:]')
    [[ -n "$id" ]] || continue
    curl --silent --show-error --max-time 8 -o /dev/null \
      -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      -H 'content-type: application/json' \
      --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"chat_id":sys.argv[1],"text":sys.argv[2]}))' "$id" "$msg")" || true
  done
}
cleanup() { [[ -n "${cnf:-}" ]] && rm -f "$cnf" || true; [[ -n "${tmp:-}" ]] && rm -rf "$tmp" || true; }
finish() {
  local rc=$?
  trap - EXIT
  cleanup
  if (( rc != 0 )); then
    [[ -z "${OUT:-}" ]] || rm -rf -- "$OUT"
    notify_admins "⚠️ TRON Energy Bot 备份失败。主机：$(hostname)；时间：$(date -u +%FT%TZ)。请检查 systemd 日志。"
  fi
  exit "$rc"
}
trap finish EXIT
[[ $EUID -eq 0 ]] || { echo 'ERROR: run as root' >&2; exit 1; }
[[ -r "$ENV_FILE" ]] || { echo "ERROR: cannot read $ENV_FILE" >&2; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "ERROR: app directory missing: $APP_DIR" >&2; exit 1; }
command -v mysqldump >/dev/null && command -v mysql >/dev/null && command -v tar >/dev/null && command -v sha256sum >/dev/null && command -v age >/dev/null || { echo 'ERROR: required command missing (including age)' >&2; exit 1; }
mode=$(stat -c '%a' "$ENV_FILE")
(( (8#$mode & 0022) == 0 )) || { echo "ERROR: $ENV_FILE must not be group/world writable" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
DB_NAME=${DB_NAME:-tron_energy}
: "${DB_USER:?DB_USER is required in env file}"
: "${DB_PASSWORD:?DB_PASSWORD is required in env file}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT must be set; plaintext backups are disabled}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the private age identity}"
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo 'ERROR: age identity is unreadable' >&2; exit 1; }
[[ "$(age-keygen -y "$AGE_IDENTITY_FILE")" == "$AGE_RECIPIENT" ]] || { echo 'ERROR: AGE_RECIPIENT does not match AGE_IDENTITY_FILE' >&2; exit 1; }
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || { echo 'ERROR: unsafe DB_NAME' >&2; exit 1; }
[[ "$AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]] || { echo 'ERROR: AGE_RECIPIENT must be a valid age public recipient' >&2; exit 1; }
mkdir -p "$BACKUP_ROOT"; chmod 700 "$BACKUP_ROOT"
stamp=$(date -u +%Y%m%dT%H%M%SZ); OUT="$BACKUP_ROOT/$stamp"; mkdir -m 700 "$OUT"
cnf=$(mktemp); tmp=$(mktemp -d)
escape_opt() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/}; printf '%s' "$s"; }
printf '[client]\nuser="%s"\npassword="%s"\nhost="%s"\nport=%s\n' "$(escape_opt "$DB_USER")" "$(escape_opt "$DB_PASSWORD")" "$(escape_opt "${DB_HOST:-127.0.0.1}")" "${DB_PORT:-3306}" > "$cnf"
chmod 600 "$cnf"
mysqldump --defaults-extra-file="$cnf" --single-transaction --routines --triggers --events --hex-blob "$DB_NAME" | gzip -1 > "$tmp/database.sql.gz"
tar --exclude='node_modules' --exclude='.git' --exclude='logs' -czf "$tmp/app-config.tar.gz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
cp "$ENV_FILE" "$tmp/environment.env"; chmod 600 "$tmp"/*
for f in database.sql.gz app-config.tar.gz environment.env; do age -r "$AGE_RECIPIENT" -o "$OUT/$f.age" "$tmp/$f"; done
printf 'created_utc=%s\ndatabase=%s\napp_dir=%s\nencryption=age\n' "$stamp" "$DB_NAME" "$APP_DIR" > "$OUT/MANIFEST.txt"
(cd "$OUT" && sha256sum database.sql.gz.age app-config.tar.gz.age environment.env.age > SHA256SUMS)
chmod 600 "$OUT"/*
# Verify the encrypted artifacts before declaring success.
(cd "$OUT" && sha256sum -c SHA256SUMS)
for f in database.sql.gz.age app-config.tar.gz.age environment.env.age; do age -d -i "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the private age identity}" -o "$tmp/${f%.age}" "$OUT/$f"; done
gzip -t "$tmp/database.sql.gz"; tar -tzf "$tmp/app-config.tar.gz" >/dev/null
if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  command -v rclone >/dev/null || { echo 'ERROR: RCLONE_REMOTE set but rclone missing' >&2; exit 1; }
  [[ "$RCLONE_REMOTE" != *..* ]] || { echo 'ERROR: unsafe RCLONE_REMOTE' >&2; exit 1; }
  remote_dest="$RCLONE_REMOTE/${RCLONE_PATH:-tron-energy-bot}/$stamp"
  rclone copy "$OUT" "$remote_dest" --create-empty-src-dirs
  rclone check "$OUT" "$remote_dest" --one-way
fi
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf -- {} +
trap - EXIT; cleanup
notify_admins "✅ TRON Energy Bot 加密备份完成。主机：$(hostname)；时间：$(date -u +%FT%TZ)；加密文件已验证。"
echo "Encrypted backup complete: $OUT"
