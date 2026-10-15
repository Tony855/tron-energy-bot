#!/usr/bin/env bash
set -Eeuo pipefail
ENV_FILE=${ENV_FILE:-/etc/tron-energy-bot.env}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3080/health}
SERVICE_NAME=${SERVICE_NAME:-tron-energy}
BACKUP_TIMER=${BACKUP_TIMER:-tron-energy-backup.timer}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/tron-energy-bot}
BACKUP_MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-30}
DISK_WARN_PERCENT=${DISK_WARN_PERCENT:-85}
STATE_FILE=${OPS_MONITOR_STATE_FILE:-/var/lib/tron-energy-bot/ops-monitor-state}
mkdir -p "$(dirname "$STATE_FILE")"
chmod 700 "$(dirname "$STATE_FILE")"
issues=()
command -v curl >/dev/null 2>&1 || issues+=("缺少 curl")
command -v systemctl >/dev/null 2>&1 || issues+=("缺少 systemctl")
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet "$SERVICE_NAME" || issues+=("应用服务 $SERVICE_NAME 未运行")
  systemctl is-active --quiet "$BACKUP_TIMER" || issues+=("备份定时器 $BACKUP_TIMER 未运行")
fi
if command -v curl >/dev/null 2>&1; then
  if ! body=$(curl --connect-timeout 3 --max-time 8 -fsS "$HEALTH_URL" 2>/dev/null); then
    issues+=("健康接口不可访问: $HEALTH_URL")
  elif ! node -e 'const x=JSON.parse(process.argv[1]); if(x.ok!==true || x.database!=="ok") process.exit(1)' "$body" 2>/dev/null; then
    issues+=("应用健康接口报告异常或数据库不可用")
  fi
fi
if [[ -d "$BACKUP_ROOT" ]]; then
  latest=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
  if [[ -z "$latest" ]]; then
    issues+=("未找到备份目录")
  else
    age_seconds=$(( $(date +%s) - $(stat -c %Y "$latest") ))
    if (( age_seconds > BACKUP_MAX_AGE_HOURS * 3600 )); then
      issues+=("最新备份已超过 ${BACKUP_MAX_AGE_HOURS} 小时: $(basename "$latest")")
    fi
  fi
else
  issues+=("备份目录不存在: $BACKUP_ROOT")
fi
usage=$(df -P "$BACKUP_ROOT" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [[ "$usage" =~ ^[0-9]+$ ]] && (( usage >= DISK_WARN_PERCENT )); then
  issues+=("备份磁盘使用率 ${usage}%（阈值 ${DISK_WARN_PERCENT}%）")
fi

fingerprint() { printf '%s\n' "$*" | sha256sum | awk '{print $1}'; }
if ((${#issues[@]})); then
  status="FAIL: $(printf '%s; ' "${issues[@]}")"
else
  status="OK: 服务、数据库、备份定时器和最近备份均正常"
fi
current=$(fingerprint "$status")
previous=""
[[ -r "$STATE_FILE" ]] && previous=$(cat "$STATE_FILE" 2>/dev/null || true)
printf '%s' "$current" > "$STATE_FILE.tmp"
chmod 600 "$STATE_FILE.tmp"
mv -f "$STATE_FILE.tmp" "$STATE_FILE"
notify() {
  local msg="$1" token ids id payload
  [[ -r "$ENV_FILE" ]] || return 0
  # The environment file is root-managed configuration and must not be writable by group/world.
  local mode; mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 777)
  (( (8#$mode & 0022) == 0 )) || return 0
  set -a; source "$ENV_FILE"; set +a
  token=${BOT_TOKEN:-}; ids=${ADMIN_TELEGRAM_IDS:-}
  [[ -n "$token" && -n "$ids" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  IFS=',' read -ra arr <<< "$ids"
  for id in "${arr[@]}"; do
    id=$(printf '%s' "$id" | tr -d '[:space:]'); [[ -n "$id" ]] || continue
    payload=$(python3 -c 'import json,sys; print(json.dumps({"chat_id":sys.argv[1],"text":sys.argv[2]}))' "$id" "$msg") || continue
    curl --silent --max-time 8 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" -H 'content-type: application/json' --data-binary "$payload" || true
  done
}
if [[ "$current" != "$previous" ]]; then
  if ((${#issues[@]})); then notify "⚠️ TRON Energy Bot 运维告警\n主机：$(hostname)\n时间：$(date -u +%FT%TZ)\n$status"
  elif [[ -n "$previous" ]]; then notify "✅ TRON Energy Bot 运维状态已恢复\n主机：$(hostname)\n时间：$(date -u +%FT%TZ)\n$status"; fi
fi
if ((${#issues[@]})); then printf '%s\n' "$status" >&2; exit 1; fi
printf '%s\n' "$status"
