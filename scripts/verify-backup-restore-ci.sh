#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
DB_NAME="tron_backup_restore_test"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-root}"
cleanup() {
  MYSQL_PWD="$DB_PASSWORD" mysql --protocol=tcp -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -e "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null 2>&1 || true
  sudo rm -rf "$TMP_DIR"
}
trap cleanup EXIT

for cmd in mysql mysqldump age age-keygen sha256sum tar gzip sudo; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required command: $cmd" >&2; exit 2; }
done

AGE_IDENTITY_FILE="$TMP_DIR/age-identity.txt"
age-keygen -o "$AGE_IDENTITY_FILE" >/dev/null
AGE_RECIPIENT="$(age-keygen -y "$AGE_IDENTITY_FILE")"
APP_DIR="$TMP_DIR/app"
BACKUP_ROOT="$TMP_DIR/backups"
ENV_FILE="$TMP_DIR/environment.env"
mkdir -m 700 "$APP_DIR" "$BACKUP_ROOT"
printf 'restore-drill fixture\\n' > "$APP_DIR/fixture.txt"
cat > "$ENV_FILE" <<ENV
DB_NAME=$DB_NAME
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
AGE_RECIPIENT=$AGE_RECIPIENT
AGE_IDENTITY_FILE=$AGE_IDENTITY_FILE
ENV

chmod 600 "$ENV_FILE" "$AGE_IDENTITY_FILE"
MYSQL_PWD="$DB_PASSWORD" mysql --protocol=tcp -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" <<SQL
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE $DB_NAME.users (id BIGINT PRIMARY KEY, marker VARCHAR(64) NOT NULL);
INSERT INTO $DB_NAME.users (id, marker) VALUES (1, 'backup-restore-ci-fixture');
SQL

sudo env ENV_FILE="$ENV_FILE" APP_DIR="$APP_DIR" BACKUP_ROOT="$BACKUP_ROOT" bash "$ROOT_DIR/scripts/backup.sh"
BACKUP_DIR="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$BACKUP_DIR" ]] || { echo 'backup directory not created' >&2; exit 1; }
sudo env ENV_FILE="$ENV_FILE" bash "$ROOT_DIR/scripts/restore-drill.sh" "$BACKUP_DIR" | tee "$TMP_DIR/restore.log"
grep -q 'users=1' "$TMP_DIR/restore.log"
echo '[backup-restore-ci] encrypted backup and isolated database restore passed'
