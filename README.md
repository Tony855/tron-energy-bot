# TRON Energy Bot V3.5

V3.0 重点改进升级安全性：先生成并验证 age 加密备份，再在独立发布目录安装依赖并执行检查/测试；通过后才切换线上目录。切换后的健康检查或监控检查失败时，脚本会尝试恢复旧版本，并保留失败版本供排查。移除了旧升级脚本里额外生成的明文应用压缩包，避免配置文件被明文副本长期留在 `/root`。

## 功能范围

- Telegram 用户机器人与 Web 管理后台
- MySQL、RBAC 管理员权限、共享登录限流与会话撤销
- TRON 充值核验、提现核验、财务账本和异常审计
- age 加密备份、可选 rclone 异地复制、备份验证与恢复演练
- systemd 每日备份 timer 与每 5 分钟运维监控 timer
- V3.0 独立发布目录、切换后健康检查、失败自动回滚尝试

## 升级 V2.9 → V3.0

1. 先确认 `/etc/tron-energy-bot.env` 中 `AGE_RECIPIENT` 与 `AGE_IDENTITY_FILE` 匹配，私钥文件可读，且备份存储空间足够。
2. 确认实际部署目录为 `/opt/tron-energy-bot`、systemd 服务为 `tron-energy`，服务运行用户为 `tronbot`。如不一致，先检查并修改 `upgrade-v3.0.sh` 顶部变量/服务配置，不要直接运行。
3. 在解压后的 V3.0 项目根目录执行：

   ```bash
   sudo bash upgrade-v3.0.sh
   ```

4. 升级后检查：

   ```bash
   systemctl status tron-energy --no-pager
   systemctl status tron-energy-backup.timer tron-energy-ops-monitor.timer --no-pager
   curl -fsS http://127.0.0.1:3080/health
   ```

升级脚本先执行加密备份与备份验证，再准备新版本；只有检查和测试通过才停止线上服务并切换。旧版本会保留在 `/opt/tron-energy-releases/previous-TIMESTAMP`，失败的新版本会保留在 `failed-TIMESTAMP`。回滚是尽力恢复机制，仍需人工检查 systemd 日志和健康接口；请勿把它当作无需维护的零停机升级。

## 运维监控

```bash
sudo /opt/tron-energy-bot/scripts/ops-monitor.sh
sudo systemctl status tron-energy-ops-monitor.timer
sudo journalctl -u tron-energy-ops-monitor.service -n 100 --no-pager
```

可在 `/etc/tron-energy-bot.env` 中设置 `BACKUP_MAX_AGE_HOURS=30`、`DISK_WARN_PERCENT=85`、`HEALTH_URL=http://127.0.0.1:3080/health` 与 `OPS_MONITOR_STATE_FILE=/var/lib/tron-energy-bot/ops-monitor-state`。环境文件必须由 root 管理且不可被组或其他用户写入。

## 测试与边界

```bash
npm run check
npm test
```

自动化测试不能替代真实服务器、数据库和链上验收。当前版本未集成真实能量供应商 API，不执行自动私钥签名或自动链上付款；`AUTO_CREDIT_CONFIRMED` 应保持关闭，除非已完成独立审计与真实环境验证。主机完全宕机时，本机监控无法告警。加密备份私钥须离线保管；丢失私钥可能导致备份无法恢复。


## V3.1：Telegram 与地址监听完善

- 监听器同时扫描已确认的 TRX 原生 `TransferContract` 与配置的 USDT-TRC20 合约。
- 每个钱包保存独立的扫描起点及 TRX/TRC20 分页游标；达到每轮页数上限时保留游标，下一轮继续补扫，避免大地址历史交易只重复第一页。
- 默认首次回补最近 24 小时；扫描完成后使用 5 分钟重叠窗口并按交易/事件幂等去重。可通过 `TRON_INITIAL_BACKFILL_HOURS`、`TRON_SCAN_PAGE_SIZE`、`TRON_SCAN_MAX_PAGES`、`TRON_SCAN_OVERLAP_MS` 调整。
- Telegram 新增 `/status`、`/transactions`、`/removewallet`；管理员可使用 `/pendingrecharges`、`/verifyrecharge ID`、`/approverecharge ID`、`/rejectrecharge ID 原因`。管理员命令仅对 `ADMIN_TELEGRAM_IDS` 中的 Telegram 数字 ID 开放。
- 链上充值必须先通过指定 USDT 合约、目标充值地址、精确金额和已确认 Transfer 事件核验，才允许管理员入账；默认不自动入账。

### 从 V3.0 升级

在 V3.1 源码根目录执行：

```bash
sudo bash upgrade-v3.1.sh
```

升级脚本会先执行 V3.0 的加密备份流程、在独立目录安装依赖并运行测试，再应用 `scripts/migrate-v3.1.js` 的增量数据库迁移，最后切换服务并健康检查。升级前确认 `AGE_RECIPIENT` 与 `AGE_IDENTITY_FILE` 匹配。

注意：TRONGrid 接口有速率限制，首次回补大量历史交易需要多轮完成。轮询不是实时推送；只有节点返回的已确认交易会被处理。请先在测试环境验证地址格式、TRONGrid API Key 和充值核验流程。真实能量供应商与自动链上付款仍未接入。


## V3.2 — event-only + Socket.IO (IMPORTANT)

This mode **does not poll TronGrid**. TronGrid's public HTTPS API is NOT a WebSocket event feed. You must contract with an independent TRON mainnet push/webhook provider; without one the monitor remains idle and deposits cannot be automatically detected. Configure `TRON_EVENT_WEBHOOK_SECRET` (random 32+ bytes), `TRON_USDT_CONTRACT` and set `TRON_EVENT_ONLY=true`.

Provider POST `/api/events/tron`, JSON `{"network":"mainnet","txHash":"64-character lowercase transaction hash"}`; header `x-tron-signature: sha256=<HMAC-SHA256(raw body, secret)>`. Payload is treated as a *hint*: each transaction is reverified through TronGrid's confirmed TRC20 event API before any persistence. Telegram notifications use the existing notifier; admin browser can connect to `/socket.io` with `auth:{token:<admin JWT>}` and listen for `tron:transfer` and `monitor:status`. No automatic credit from events in this mode.

Limitations: V3.2 event-only webhook supports **confirmed USDT-TRC20** transaction hints; TRX transfer ingestion, provider-specific push adapters, provider delivery guarantees, missed-event replay, and browser dashboard wiring are **not** implemented. Socket.IO does not create a TRON blockchain subscription. An authenticated, trusted event provider is mandatory. Nginx must proxy websocket upgrades on `/socket.io`.

## V3.3 — customer data isolation

- Every Telegram customer is identified by `users.id` (linked uniquely to Telegram ID). Wallets, transaction history, recharge orders, withdrawals, energy orders, ledger entries, and referral statistics are queried under that owner.
- Wallet address uniqueness is now `(user_id,address)`, so two customers can independently monitor the same public address without sharing wallet rows, transaction rows, labels, scan state, or notification settings. Dedicated deposit addresses remain globally unique and allocated to one customer at a time.
- A composite database foreign key prevents a recharge order from referencing another customer's wallet. Migration stops if it finds existing recharge/wallet ownership mismatches; it will not guess which customer should own the record.
- Each detected event is saved against the matching customer's wallet row. Telegram transfer notifications are sent to that wallet owner's Telegram account; Socket.IO events remain on the authenticated admin channel, not a shared customer room.
- No customer-facing web login/session is provided in this release; customer interaction remains through Telegram. The web console is an admin console and can view multiple customers according to the administrator's role.

Upgrade from V3.2 from the V3.3 source directory:

```bash
sudo bash upgrade-v3.3.sh
```

The migration applies `scripts/migrate-v3.1.js` and `scripts/migrate-v3.3.js` after creating an encrypted backup and running tests. Verify database backup and review migration output before production use. Database-level constraints and automated source tests do not replace a real MySQL integration test.

## V3.4 — Telegram 顾客交互体验

- Reworked the customer home menu into compact inline-button navigation for wallets, energy service, balance, deposit, withdrawal, transactions, monitoring status, daily report, referrals, and help.
- Added wallet sub-menu actions for add/list/disable/resources. Guided text-input states are keyed by Telegram user ID and can be cancelled.
- Deposit and withdrawal buttons now execute their own guarded flow rather than sending slash-command text as a bot message. Customer-facing lists and mutations are scoped by the authenticated Telegram user.
- Registered Telegram command suggestions with Bot API at startup.
- The energy menu explicitly states that no real supplier is connected; it never claims a rental succeeded. Deposit remains chain-verification + manual-review gated.


## V3.5：一键安装脚本加固

全新安装（Debian/Ubuntu + systemd）请在项目根目录执行：

```bash
sudo bash install.sh
```

安装脚本会检查操作系统、systemd、项目目录和配置冲突；安装 Node.js 22+、MySQL、Nginx、age 与 rsync；收集 Telegram Token、网页管理员密码、MySQL 密码、管理员 Telegram 数字 ID、域名、TRONGrid Key 和事件 Webhook 密钥；安装生产依赖并运行 `npm run check` 与 `npm test`；初始化数据库并验证应用账号通过 TCP 连接；生成 JWT 密钥、bcrypt 管理员密码哈希、root-only 环境文件和 age 加密备份身份；配置 systemd、备份/运维 timer，并等待健康接口成功。

安全和运行说明：

- `install.sh` 是全新安装脚本。如果 `/opt/tron-energy-bot` 已有内容、`/etc/tron-energy-bot.env` 或 systemd 服务已存在，脚本会拒绝覆盖；已有部署请使用对应的 `upgrade-v*.sh`。
- MySQL 应用账号使用 `'tronbot'@'127.0.0.1'`，与 `DB_HOST=127.0.0.1` 保持一致，并在启动服务前进行连接验证。
- 默认 `TRON_EVENT_ONLY=true`、`AUTO_CREDIT_CONFIRMED=false`。TronGrid 公共 HTTPS API 不会主动推送事件，必须配置第三方 TRON 主网事件 Webhook 服务；脚本不会伪造实时链上监听。
- 如果填写域名，脚本只配置 Nginx HTTP 反向代理（包括 WebSocket Upgrade）。DNS 指向本机后，仍需按提示单独安装 Certbot 并签发 HTTPS 证书。
- 安装脚本会在 `/etc/tron-energy-bot.env` 生成随机 Webhook HMAC 密钥。该文件权限为 0600，仅 root 可读；需由管理员安全地将密钥配置到第三方事件服务。
- 脚本在结束前检查 `http://127.0.0.1:3080/health`。如果失败，会输出服务日志并以失败退出，不会报告安装成功。
- 一键安装仍需要真实服务器网络、APT 仓库和 npm registry 可用；本地自动化测试不能替代真实 Debian/Ubuntu 安装演练。
