#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ENV_FILE=${ENV_FILE:-/etc/tron-energy-bot.env}
DIR=${1:?Usage: restore-drill.sh /path/to/backup-directory}
[[ $EUID -eq 0 ]] || { echo 'ERROR: run as root' >&2; exit 1; }
[[ -r "$ENV_FILE" ]] || { echo "ERROR: cannot read $ENV_FILE" >&2; exit 1; }
"$(dirname "$0")/verify-backup.sh" "$DIR"
set -a; source "$ENV_FILE"; set +a
: "${DB_USER:?DB_USER required}"; : "${DB_PASSWORD:?DB_PASSWORD required}"; : "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE required}"
DB_HOST=${DB_HOST:-127.0.0.1}; DB_PORT=${DB_PORT:-3306}
restore_db="tron_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
cnf=$(mktemp); tmp=$(mktemp -d)
escape_opt() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/}; printf '%s' "$s"; }
printf '[client]\nuser="%s"\npassword="%s"\nhost="%s"\nport=%s\n' "$(escape_opt "$DB_USER")" "$(escape_opt "$DB_PASSWORD")" "$(escape_opt "$DB_HOST")" "$DB_PORT" > "$cnf"; chmod 600 "$cnf"
cleanup() { if [[ ${KEEP_RESTORE_DB:-0} != 1 ]]; then mysql --defaults-extra-file="$cnf" -e "DROP DATABASE IF EXISTS ${restore_db}" || true; else echo "Restore drill database retained: $restore_db"; fi; rm -f "$cnf"; rm -rf "$tmp"; }
trap cleanup EXIT
age -d -i "$AGE_IDENTITY_FILE" -o "$tmp/database.sql.gz" "$DIR/database.sql.gz.age"
mysql --defaults-extra-file="$cnf" -e "CREATE DATABASE ${restore_db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc "$tmp/database.sql.gz" | mysql --defaults-extra-file="$cnf" "$restore_db"
tables=$(mysql --defaults-extra-file="$cnf" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$restore_db'")
(( tables > 0 )) || { echo 'ERROR: restored database has no tables' >&2; exit 1; }
users=$(mysql --defaults-extra-file="$cnf" -N "$restore_db" -e 'SELECT COUNT(*) FROM users' 2>/dev/null || echo 'table-not-present')
echo "Restore drill succeeded: tables=$tables users=$users database=$restore_db"
echo 'This is a disposable restore test, not a production cutover.'
