#!/usr/bin/env bash
set -Eeuo pipefail
ENV_FILE=${ENV_FILE:-/etc/tron-energy-bot.env}
URL=${HEALTH_URL:-http://127.0.0.1:3080/health}
DISK_WARN_PERCENT=${DISK_WARN_PERCENT:-85}
notify() {
  local msg="$1" token ids id
  [[ -r "$ENV_FILE" ]] || return 0
  set -a; source "$ENV_FILE"; set +a
  token=${BOT_TOKEN:-}; ids=${ADMIN_TELEGRAM_IDS:-}
  [[ -n "$token" && -n "$ids" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  IFS=',' read -ra arr <<< "$ids"
  for id in "${arr[@]}"; do
    id=$(printf '%s' "$id" | tr -d '[:space:]'); [[ -n "$id" ]] || continue
    curl --silent --max-time 8 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      -H 'content-type: application/json' \
      --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"chat_id":sys.argv[1],"text":sys.argv[2]}))' "$id" "$msg")" || true
  done
}
finish() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 )); then notify "⚠️ TRON Energy Bot 健康检查失败。主机：$(hostname)；时间：$(date -u +%FT%TZ)。请检查服务、数据库和磁盘。"; fi
  exit "$rc"
}
trap finish EXIT
command -v curl >/dev/null || { echo 'FAIL: curl missing'; exit 2; }
command -v node >/dev/null || { echo 'FAIL: node missing'; exit 2; }
body=$(curl --connect-timeout 3 --max-time 8 -fsS "$URL")
node -e 'const x=JSON.parse(process.argv[1]); if(x.ok!==true || x.database!=="ok") process.exit(1)' "$body"
usage=$(df -P "${BACKUP_ROOT:-/var/backups/tron-energy-bot}" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [[ -n "$usage" && "$usage" -ge "$DISK_WARN_PERCENT" ]]; then
  notify "⚠️ TRON Energy Bot 备份磁盘空间不足。主机：$(hostname)；使用率：${usage}%；阈值：${DISK_WARN_PERCENT}%。"
  echo "WARN: backup filesystem usage ${usage}% (threshold ${DISK_WARN_PERCENT}%)"; exit 3
fi
echo 'OK: application health and backup filesystem checks passed'
