#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
DIR=${1:?Usage: verify-backup.sh /path/to/backup-directory}
ENV_FILE=${ENV_FILE:-/etc/tron-energy-bot.env}
[[ -d "$DIR" && -f "$DIR/SHA256SUMS" ]] || { echo 'ERROR: backup directory or SHA256SUMS missing' >&2; exit 1; }
(cd "$DIR" && sha256sum -c SHA256SUMS)
if [[ -f "$DIR/database.sql.gz.age" ]]; then
  [[ -r "$ENV_FILE" ]] || { echo "ERROR: cannot read $ENV_FILE" >&2; exit 1; }
  set -a; source "$ENV_FILE"; set +a
  : "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the private age identity}"
  [[ -r "$AGE_IDENTITY_FILE" ]] || { echo 'ERROR: age identity is unreadable' >&2; exit 1; }
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  age -d -i "$AGE_IDENTITY_FILE" -o "$tmp/database.sql.gz" "$DIR/database.sql.gz.age"
  age -d -i "$AGE_IDENTITY_FILE" -o "$tmp/app-config.tar.gz" "$DIR/app-config.tar.gz.age"
  age -d -i "$AGE_IDENTITY_FILE" -o "$tmp/environment.env" "$DIR/environment.env.age"
  gzip -t "$tmp/database.sql.gz"; tar -tzf "$tmp/app-config.tar.gz" >/dev/null
elif [[ -f "$DIR/database.sql.gz" ]]; then
  echo 'ERROR: plaintext legacy backup rejected by V2.8 verifier. Use an isolated migration procedure.' >&2; exit 1
else
  echo 'ERROR: expected encrypted backup artifacts missing' >&2; exit 1
fi
[[ -s "$DIR/MANIFEST.txt" ]] || { echo 'ERROR: manifest missing' >&2; exit 1; }
echo 'Encrypted backup integrity and decryptability checks passed. This does not prove a full application restore works.'
