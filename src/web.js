const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { creditRecharge, postBalanceEntry } = require('./ledger');
const { validateAddress, getConfirmedTrc20Transfer, decimalToRaw, matchWithdrawalTransfer } = require('./tron');
const { sendTelegramMessage } = require('./notifier');
const { assignNextDepositAddress, importDepositAddresses } = require('./depositPool');
const { pool } = require('./db');
const { getEnergyProvider } = require('./providers/energyProvider');
const { toCsv, validDateRange } = require('./reconciliation');
const { runBackfill } = require('./chainBackfill');
const { parseDateRange } = require('./dateRange');
const { checkAndAlert } = require('./chainAlerts');
const { runFinanceAudit } = require('./financeAudit');
const { verifyDepositTransfer } = require('./chainDepositVerify');
const { createSharedLoginGuard } = require('./sharedLoginGuard');
const { canAccess, VALID_ROLES } = require('./rbac');

const loginGuard = createSharedLoginGuard(pool, { maxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5), windowMs: Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000), lockMs: Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000) });

const app = express();
app.set('trust proxy', 'loopback');
require('./miniapp-mount')(app);
app.use(helmet({ contentSecurityPolicy: false }));
app.post('/api/events/tron', express.raw({ type: 'application/json', limit: '32kb' }), async (req, res) => {
  if (!process.env.TRON_EVENT_WEBHOOK_SECRET) return res.status(503).json({ error: 'event provider not configured' });
  try { return res.json(await require('./eventBridge').handleEvent(req.body, req.get('x-tron-signature'))); }
  catch (e) { return res.status(e.status || 503).json({ error: e.status ? e.message : 'chain verification unavailable' }); }
});
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'tron-energy-bot', audience: 'tron-energy-admin' });
    if (!claims || typeof claims.username !== 'string' || !VALID_ROLES.includes(claims.role)) throw new Error('invalid token claims');
  } catch {
    return res.status(401).json({ error: '管理员登录已失效，请重新登录' });
  }
  try {
    const rows = await query('SELECT username,role,is_active,token_version FROM admin_users WHERE username=? LIMIT 1', [claims.username]);
    if (rows.length) {
      const account = rows[0];
      if (Number(account.is_active) !== 1 || account.role !== claims.role || Number(account.token_version || 0) !== Number(claims.token_version || 0)) {
        return res.status(401).json({ error: '管理员账户或会话已变更，请重新登录' });
      }
      req.admin = { ...claims, role: account.role };
    } else if (claims.emergency === true && claims.username === process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
      req.admin = claims;
    } else {
      return res.status(401).json({ error: '管理员账户不存在或已停用，请重新登录' });
    }
  } catch {
    return res.status(503).json({ error: '无法验证管理员会话，请稍后重试' });
  }
  if (!canAccess(req.admin.role, req.method, req.path)) return res.status(403).json({ error: '当前管理员角色无权执行此操作' });
  return next();
}

async function audit(admin, action, targetType, targetId, details = {}, ipAddress = null) {
  await query(
    'INSERT INTO admin_audit_logs (admin_username,action,target_type,target_id,details_json,ip_address) VALUES (?,?,?,?,?,?)',
    [admin, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(details), ipAddress]
  );
}

app.get('/api/events/status', auth, (req, res) => res.json(require('./eventBridge').getStatus()));

app.get('/health', async (req, res) => {
  let database = 'ok';
  try { await pool.query('SELECT 1'); } catch { database = 'error'; }
  const provider = getEnergyProvider();
  const ok = database === 'ok';
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'tron-energy-bot',
    database,
    energyProvider: provider.enabled ? 'enabled' : 'not_configured',
    automaticCredit: process.env.AUTO_CREDIT_CONFIRMED === 'true'
  });
});

app.get('/', (req, res) => res.type('html').send(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRON 能量管理后台</title>
<style>
:root{color-scheme:dark;--bg:#0b1220;--panel:#111c2d;--line:#26374e;--text:#edf4ff;--muted:#91a4bd;--accent:#42d6a0}
*{box-sizing:border-box}body{font:14px/1.55 system-ui,-apple-system,sans-serif;background:linear-gradient(180deg,#101d30,#0b1220 280px);color:var(--text);margin:0;padding:clamp(12px,3vw,28px)}
main{max-width:1120px;margin:auto}h1{font-size:clamp(22px,4vw,30px);letter-spacing:-.5px;margin:4px 0 6px}h2{font-size:17px;margin:0 0 12px}section,.card{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:clamp(14px,2.5vw,20px);margin:12px 0;box-shadow:0 8px 24px #00000012}
input,select,textarea{width:auto;max-width:100%;padding:11px 12px;border-radius:9px;border:1px solid #344861;background:#0b1524;color:var(--text);margin:4px;font:inherit;min-height:42px}
input:focus,select:focus,textarea:focus{outline:2px solid #42d6a055;border-color:var(--accent)}
button{padding:10px 15px;border-radius:9px;border:1px solid #2a745b;background:#15392f;color:#a2f4d4;margin:4px;font:inherit;font-weight:650;cursor:pointer;min-height:40px}
button:hover{filter:brightness(1.12)}button:disabled{opacity:.5;cursor:wait}
table{border-collapse:collapse;width:100%;min-width:560px}td,th{text-align:left;padding:11px 10px;border-bottom:1px solid #26374e;overflow-wrap:anywhere}th{color:#a7bad1;font-size:12px;font-weight:650}tr:hover td{background:#ffffff04}
.small{color:var(--muted);font-size:12px}#app{display:none}.row{display:flex;gap:10px;flex-wrap:wrap}.row .card{flex:1;min-width:min(180px,100%)}#msg{color:#ffb3a8}
@media(max-width:600px){body{padding:12px}section{padding:13px;overflow-x:auto}.row .card{min-width:130px}input,select{width:100%;margin:4px 0}button{margin:4px 2px}}

.tabbar{display:flex;gap:6px;overflow-x:auto;padding:8px 0;margin-bottom:10px;flex-wrap:nowrap}
.tabbar button{padding:8px 14px;border-radius:9px;border:1px solid #2d415b;background:#19283c;color:#a7bad1;font-size:13px;white-space:nowrap;cursor:pointer;min-height:38px}
.tabbar button.active{background:#15392f;border-color:#2a745b;color:#8ef0c5}
main > section[data-tab-hidden]{display:none}
</style><main><h1>TRON 能量管理后台</h1><p class="small">V2.6 · 共享登录限流、管理员会话即时撤销、角色权限与链上核验</p>
<section id="login"><h2>管理员登录</h2><input id="username" placeholder="用户名" value="admin"><input id="password" type="password" placeholder="密码"><button onclick="login()">登录</button><p id="msg"></p></section>
<div id="app"><div class="row" id="stats"></div><section><h2>分配独立充值地址</h2><p class="small">填写现有、由你安全控制的 TRON 地址。此页面不会生成钱包或保存私钥。</p><input id="walletUserId" type="number" min="1" placeholder="用户内部 ID"><input id="walletAddress" placeholder="T 开头的 TRON 地址" style="min-width:340px"><input id="walletLabel" placeholder="标签（可选）"><button onclick="assignWallet()">分配地址</button><p id="walletMsg"></p></section>
<section><h2>TRON 历史交易补扫（V1.7）</h2><p class="small">仅扫描已分配的专属充值地址；每次每个地址最多 5 页。历史发现的充值仍需人工核验，不会自动入账。</p><input id="backfillFrom" type="date"><input id="backfillTo" type="date"><input id="backfillPages" type="number" min="1" max="5" value="3" style="width:90px"><button onclick="runBackfill()">开始 / 继续补扫</button><button onclick="loadBackfillStatus()">刷新补扫状态</button><pre id="backfillResult" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></section>
<section><h2>充值地址池</h2><p class="small">导入由你在外部安全生成并控制私钥的地址；每行一个地址。系统只保存地址，不保存私钥或助记词。</p><textarea id="addressPoolInput" rows="5" style="width:95%;background:#101d2e;color:#fff" placeholder="T开头的TRON地址，每行一个"></textarea><br><input id="poolLabel" placeholder="来源标签（可选）"><button onclick="importPool()">导入地址池</button><button onclick="loadPool()">刷新地址池</button><p id="poolMsg"></p><div id="poolRows"></div></section><section><h2>已分配充值地址</h2><button onclick="loadWallets()">刷新地址</button><div id="depositWallets"></div></section><section><h2>创建人工充值审核单</h2><input id="rechargeUserId" type="number" min="1" placeholder="用户内部 ID"><input id="rechargeAmount" type="number" min="0.000001" step="0.000001" placeholder="USDT 金额"><input id="rechargeNote" placeholder="备注 / 外部凭证编号"><button onclick="createRecharge()">创建待审核充值</button><p id="rechargeMsg"></p></section>
<section><h2>待审核充值</h2><button onclick="load()">刷新</button><div id="deposits"></div></section>
<section><h2>用户</h2><div id="users"></div></section><section><h2>能量订单</h2><div id="orders"></div></section><section><h2>待处理提现</h2><button onclick="loadWithdrawals()">刷新提现</button><div id="withdrawals"></div></section><section><h2>链上充值异常审计（只读）</h2><p class="small">检查已索引的充值交易是否缺少充值单、金额不一致或充值单缺少交易记录；不会自动入账。</p><button onclick="loadChainAudit()">运行链上对账</button><pre id="chainAuditOutput"></pre></section><section><h2>财务账本完整性审计（V1.9）</h2><p class="small">只读检查用户余额与账本差异、已入账充值缺少账本、提现扣款/退款记录缺失及重复提现交易哈希。不会自动修复。</p><button onclick="runFinanceAuditUi()">运行财务审计</button><pre id="financeAuditOutput" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></section><section><h2>财务对账</h2><p class="small">汇总来自系统数据库；请独立核对链上交易哈希。</p><input id="reconFrom" type="date"><input id="reconTo" type="date"><button onclick="loadRecon()">查询对账汇总</button><button onclick="exportLedger()">导出账本 CSV</button><pre id="reconOutput"></pre><div id="reconSnapshots"></div></section><section><h2>管理员账号管理（仅超级管理员）</h2><p class="small">创建独立管理员账号并分配最小权限；密码至少 12 位。该功能仅超级管理员可用。</p><input id="newAdminUsername" placeholder="新管理员用户名"><input id="newAdminPassword" type="password" placeholder="初始密码（至少12位）"><select id="newAdminRole"><option value="auditor">只读审计员</option><option value="finance">财务审核员</option><option value="operator">运营人员</option><option value="super_admin">超级管理员</option></select><button onclick="createAdmin()">创建管理员</button><button onclick="loadAdmins()">刷新管理员</button><p id="adminMsg"></p><div id="adminRows"></div></section><section><h2>管理员操作日志</h2><div id="auditLogs"></div></section></div>
<script>
(function(){
  var main = document.querySelector('main');
  if (!main) return;
  var sections = Array.prototype.slice.call(main.querySelectorAll(':scope > section'));
  if (sections.length < 2) return;
  var bar = document.createElement('nav');
  bar.className = 'tabbar';
  var names = sections.map(function(sec, i){
    var h = sec.querySelector('h2');
    return h ? h.textContent.trim() : ('TAB ' + (i+1));
  });
  function show(idx){
    sections.forEach(function(sec, i){
      if (i === idx) sec.removeAttribute('data-tab-hidden');
      else sec.setAttribute('data-tab-hidden', '');
    });
    Array.prototype.forEach.call(bar.children, function(b, i){
      b.classList.toggle('active', i === idx);
    });
  }
  names.forEach(function(name, i){
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.onclick = function(){ show(i); };
    bar.appendChild(b);
  });
  main.insertBefore(bar, main.firstChild);
  show(0);
})();
</script>
</main>
<script>
let token='';
async function api(path,opts={}){let r=await fetch('/api'+path,{...opts,headers:{'content-type':'application/json','authorization':'Bearer '+token,...(opts.headers||{})}});let d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d}
async function login(){
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const message = document.getElementById('msg');
  const button = document.querySelector('#login button');
  if (!usernameInput || !passwordInput || !message) {
    console.error('[login] 登录页面元素缺失');
    return;
  }
  message.textContent = '';
  if (button) button.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value
      })
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || ('登录失败，HTTP ' + r.status));
    if (!d.token) throw Error('登录接口未返回令牌');
    token = d.token;
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    await load();
  } catch (e) {
    message.textContent = e.message || '登录失败，请检查网络或服务器日志';
    console.error('[login]', e);
  } finally {
    if (button) button.disabled = false;
  }
}
window.login = login;
function table(rows,cols,actions){if(!rows.length)return '<p class="small">暂无数据</p>';return '<table><thead><tr>'+cols.map(c=>'<th>'+c[1]+'</th>').join('')+'<th>操作</th></tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(r[c[0]]??'')+'</td>').join('')+'<td>'+(actions?actions(r):'—')+'</td></tr>').join('')+'</tbody></table>'}
function esc(v){return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function assignWallet(){try{let d=await api('/wallets/deposit-address',{method:'POST',body:JSON.stringify({user_id:Number(walletUserId.value),address:walletAddress.value.trim(),label:walletLabel.value.trim()})});walletMsg.textContent='已分配地址：'+d.address;walletAddress.value='';await load()}catch(e){walletMsg.textContent=e.message}}
async function loadWallets(){try{let w=await api('/deposit-wallets');depositWallets.innerHTML=table(w,[['id','地址ID'],['user_id','用户ID'],['address','充值地址'],['label','标签'],['last_scanned_at','最后扫描']]);}catch(e){alert(e.message)}}
async function importPool(){try{let d=await api('/deposit-address-pool/import',{method:'POST',body:JSON.stringify({addresses:addressPoolInput.value,source_label:poolLabel.value})});poolMsg.textContent='导入完成：新增 '+d.imported+'，跳过重复 '+d.skipped;addressPoolInput.value='';await loadPool()}catch(e){poolMsg.textContent=e.message}}
async function loadPool(){try{let d=await api('/deposit-address-pool');poolRows.innerHTML='<p class="small">可用地址：'+d.available_count+'，已分配：'+d.assigned_count+'，禁用：'+d.disabled_count+'</p>'+table(d.rows,[['id','池ID'],['address','地址'],['status','状态'],['source_label','来源'],['assigned_user_id','用户ID'],['created_at','导入时间']]);}catch(e){poolRows.textContent=e.message}}
async function assignFromPool(id){if(!confirm('为用户 '+id+' 分配下一个专属充值地址？'))return;try{let d=await api('/deposit-address-pool/assign/'+id,{method:'POST'});alert('充值地址：'+d.address);await load()}catch(e){alert(e.message)}}
async function createRecharge(){try{let d=await api('/deposits/manual',{method:'POST',body:JSON.stringify({user_id:Number(rechargeUserId.value),amount:rechargeAmount.value,note:rechargeNote.value})});rechargeMsg.textContent='已创建待审核订单 #'+d.id;await load()}catch(e){rechargeMsg.textContent=e.message}}
async function verifyDeposit(id){if(!confirm('从 TRON 主网核对交易、USDT 合约、收款地址和金额？核验不会自动入账。'))return;try{const d=await api('/deposits/'+id+'/verify-chain',{method:'POST'});alert('链上核验通过，但尚未入账。\\n交易：'+d.tx_hash+'\\n金额：'+d.amount+' USDT');await load()}catch(e){alert('链上核验未通过：'+e.message)}}
async function approve(id){if(!confirm('确认审核并入账？'))return;try{await api('/deposits/'+id+'/approve',{method:'POST'});await load()}catch(e){alert(e.message)}}
async function reject(id){let note=prompt('拒绝原因');if(note===null)return;try{await api('/deposits/'+id+'/reject',{method:'POST',body:JSON.stringify({note})});await load()}catch(e){alert(e.message)}}
async function approveWithdrawal(id){if(!confirm('批准提现并从可用余额扣款？链上转账仍需人工执行。'))return;try{await api('/withdrawals/'+id+'/approve',{method:'POST'});await loadWithdrawals()}catch(e){alert(e.message)}}
async function rejectWithdrawal(id){let note=prompt('拒绝原因');if(note===null)return;try{await api('/withdrawals/'+id+'/reject',{method:'POST',body:JSON.stringify({note})});await loadWithdrawals()}catch(e){alert(e.message)}}
async function markWithdrawalPaid(id){let tx_hash=prompt('录入已完成的 TRON 交易哈希（系统会核验主网交易）');if(!tx_hash)return;try{await api('/withdrawals/'+id+'/paid',{method:'POST',body:JSON.stringify({tx_hash})});await loadWithdrawals()}catch(e){alert(e.message)}}
async function loadWithdrawals(){try{let w=await api('/withdrawals?status=pending');withdrawals.innerHTML=table(w,[['id','提现单'],['user_id','用户'],['amount','金额'],['currency','币种'],['destination_address','收款地址'],['status','状态']],r=>'<button onclick="approveWithdrawal('+r.id+')">批准扣款</button><button onclick="rejectWithdrawal('+r.id+')">拒绝</button>');let a=await api('/withdrawals?status=approved');withdrawals.innerHTML += '<h3>已批准，待人工转账</h3>'+table(a,[['id','提现单'],['user_id','用户'],['amount','金额'],['destination_address','收款地址'],['status','状态']],r=>'<button onclick="markWithdrawalPaid('+r.id+')">核验交易哈希并完成</button>')}catch(e){withdrawals.textContent=e.message}}
async function loadChainAudit(){try{let d=await api('/chain-audit');chainAuditOutput.textContent=JSON.stringify(d,null,2)}catch(e){chainAuditOutput.textContent=e.message}}
async function runFinanceAuditUi(){try{let d=await api('/finance-audit');financeAuditOutput.textContent=JSON.stringify(d,null,2)}catch(e){financeAuditOutput.textContent=e.message}}
async function loadRecon(){try{let from=reconFrom.value,to=reconTo.value;let d=await api('/reconciliation/summary?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to));reconOutput.textContent=JSON.stringify(d,null,2);let s=await api('/reconciliation/snapshots');reconSnapshots.innerHTML=table(s,[['id','快照'],['run_by','管理员'],['date_from','开始日期'],['date_to','结束日期'],['deposit_amount','充值总额'],['credited_amount','已入账'],['pending_amount','待审核'],['created_at','创建时间']]);}catch(e){reconOutput.textContent=e.message}}
async function runBackfill(){const from=backfillFrom.value,to=backfillTo.value;if(!from||!to)return alert('请选择开始和结束日期');try{const d=await api('/chain-backfill/run',{method:'POST',body:JSON.stringify({from,to,pages_per_wallet:Number(backfillPages.value||3)})});backfillResult.textContent=JSON.stringify(d,null,2)}catch(e){alert(e.message)}}
async function loadBackfillStatus(){try{const d=await api('/chain-backfill/status');backfillResult.textContent=JSON.stringify(d,null,2)}catch(e){alert(e.message)}}
async function exportLedger(){let from=reconFrom.value,to=reconTo.value;if(!from||!to)return alert('请先选择日期范围');try{let r=await fetch('/api/ledger/export.csv?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to),{headers:{'authorization':'Bearer '+token}});if(!r.ok){let d=await r.json();throw Error(d.error||'导出失败')}let blob=await r.blob();let url=URL.createObjectURL(blob);let a=document.createElement('a');a.href=url;a.download='ledger-'+from+'-'+to+'.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}catch(e){alert(e.message)}}
async function createAdmin(){try{let d=await api('/admins',{method:'POST',body:JSON.stringify({username:newAdminUsername.value,password:newAdminPassword.value,role:newAdminRole.value})});adminMsg.textContent='已创建 '+d.username+'（'+d.role+'）';newAdminPassword.value='';await loadAdmins()}catch(e){adminMsg.textContent=e.message}}
async function loadAdmins(){try{let d=await api('/admins');adminRows.innerHTML=table(d,[['id','ID'],['username','用户名'],['role','角色'],['is_active','启用'],['created_at','创建时间']],r=>'<button onclick="toggleAdmin('+r.id+','+(Number(r.is_active)===1?'false':'true')+')">'+(Number(r.is_active)===1?'停用':'启用')+'</button>')}catch(e){adminRows.textContent=e.message}}
async function toggleAdmin(id,is_active){if(!confirm('确认更改该管理员的启用状态？'))return;try{await api('/admins/'+id,{method:'PATCH',body:JSON.stringify({is_active})});await loadAdmins()}catch(e){alert(e.message)}}
async function load(){try{let d=await api('/dashboard');stats.innerHTML=Object.entries(d.stats).map(([k,v])=>'<div class="card"><div class="small">'+esc(k)+'</div><h2>'+esc(v)+'</h2></div>').join('');
let p=await api('/deposits?status=pending');deposits.innerHTML=table(p,[['id','订单'],['user_id','用户ID'],['amount','金额'],['currency','币种'],['source','来源'],['tx_hash','交易哈希'],['chain_verified_at','链上核验时间']],r=>(r.source==='tron'?'<button onclick="verifyDeposit('+r.id+')">核验链上</button> ':'')+'<button onclick="approve('+r.id+')">审核入账</button><button onclick="reject('+r.id+')">拒绝</button>');
let u=await api('/users');users.innerHTML=table(u,[['id','ID'],['telegram_id','Telegram ID'],['username','用户名'],['balance','余额'],['created_at','注册时间']],r=>'<button onclick="assignFromPool('+r.id+')">分配充值地址</button>');await loadWallets();await loadPool();await loadWithdrawals();try{await loadAdmins()}catch{}
let o=await api('/energy-orders');orders.innerHTML=table(o,[['id','订单'],['user_id','用户'],['receiver_address','接收地址'],['energy_amount','能量'],['quoted_price','报价'],['status','状态']]);let a=await api('/audit-logs');auditLogs.innerHTML=table(a,[['id','日志ID'],['admin_username','管理员'],['action','操作'],['target_type','对象'],['target_id','对象ID'],['created_at','时间']]);}catch(e){alert(e.message)}}
</script></html>`));

app.post('/api/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const username = String(req.body?.username || '').trim().slice(0, 128);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
  let decision;
  try { decision = await loginGuard.check(ip, username); } catch { return res.status(503).json({ error: '登录安全服务暂时不可用，请稍后重试' }); }
  if (!decision.allowed) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    return res.status(429).json({ error: '登录尝试过多，请稍后重试' });
  }
  if (!username || !password) {
    try { await loginGuard.fail(ip, username); } catch { return res.status(503).json({ error: '登录安全服务暂时不可用，请稍后重试' }); }
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  let account = null;
  let databaseAccountExists = false;
  try {
    const rows = await query('SELECT username,password_hash,role,is_active,token_version FROM admin_users WHERE username=? LIMIT 1', [username]);
    databaseAccountExists = !!rows[0];
    if (rows[0] && Number(rows[0].is_active) === 1) account = { username: rows[0].username, password_hash: rows[0].password_hash, role: rows[0].role };
  } catch (e) {
    // Older schema or DB outage: only the configured emergency super-admin can be used.
    if (username === process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) account = { username, password_hash: process.env.ADMIN_PASSWORD_HASH, role: 'super_admin' };
    else {
      try { await loginGuard.fail(ip, username); } catch {}
      return res.status(503).json({ error: '管理员账户暂时不可用，请检查数据库迁移' });
    }
  }
  if (!account && !databaseAccountExists && username === process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) account = { username, password_hash: process.env.ADMIN_PASSWORD_HASH, role: 'super_admin' };
  let ok = false;
  try { if (account && VALID_ROLES.includes(account.role)) ok = await bcrypt.compare(password, account.password_hash); } catch {}
  if (!ok) {
    try { await loginGuard.fail(ip, username); } catch { return res.status(503).json({ error: '登录安全服务暂时不可用，请稍后重试' }); }
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  try { await loginGuard.succeed(ip, username); } catch { return res.status(503).json({ error: '登录安全服务暂时不可用，请稍后重试' }); }
  const dbAccount = await query('SELECT token_version FROM admin_users WHERE username=? LIMIT 1', [account.username]).catch(() => []);
  const emergency = !dbAccount.length && account.username === process.env.ADMIN_USERNAME;
  const token = jwt.sign({ username: account.username, role: account.role, token_version: Number(dbAccount[0]?.token_version || 0), ...(emergency ? { emergency: true } : {}) }, process.env.JWT_SECRET, {
    expiresIn: '30m', issuer: 'tron-energy-bot', audience: 'tron-energy-admin'
  });
  try { await audit(username, 'admin_login_success', 'admin', username, { ip, role: account.role }, ip); } catch {}
  res.json({ token, expires_in: 1800, role: account.role });
});

// Super-admin only: provision named operator accounts; passwords are stored as bcrypt hashes.
app.get('/api/admins', auth, async (req, res) => {
  const rows = await query('SELECT id,username,role,is_active,created_at FROM admin_users ORDER BY id ASC');
  res.json(rows);
});
app.post('/api/admins', auth, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role = String(req.body?.role || 'auditor');
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) return res.status(400).json({ error: '用户名须为 3-64 位字母、数字、点、下划线或连字符' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: '密码长度须为 12-200 个字符' });
  if (!VALID_ROLES.includes(role) || role === 'super_admin' && req.admin.role !== 'super_admin') return res.status(400).json({ error: '管理员角色无效' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await query('INSERT INTO admin_users (username,password_hash,role,is_active) VALUES (?,?,?,1)', [username, hash, role]);
    await audit(req.admin.username, 'create_admin', 'admin', result.insertId, { username, role });
    res.status(201).json({ ok: true, id: result.insertId, username, role });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '管理员用户名已存在' });
    res.status(500).json({ error: '创建管理员失败' });
  }
});
app.patch('/api/admins/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: '管理员 ID 无效' });
  const fields = [], values = [];
  if (req.body?.role !== undefined) {
    const role = String(req.body.role);
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '管理员角色无效' });
    const target = await query('SELECT username,role FROM admin_users WHERE id=? LIMIT 1', [id]);
    if (!target.length) return res.status(404).json({ error: '管理员不存在' });
    if (target[0].username === req.admin.username && role !== 'super_admin') return res.status(409).json({ error: '不能降低当前登录超级管理员自身的角色' });
    fields.push('role=?'); values.push(role);
  }
  if (req.body?.is_active !== undefined) {
    if (typeof req.body.is_active !== 'boolean') return res.status(400).json({ error: 'is_active 必须是布尔值' });
    const target = await query('SELECT username,is_active,role FROM admin_users WHERE id=? LIMIT 1', [id]);
    if (!target.length) return res.status(404).json({ error: '管理员不存在' });
    if (target[0].username === req.admin.username && req.body.is_active === false) return res.status(409).json({ error: '不能停用当前登录账户' });
    if (target[0].role === 'super_admin' && req.body.is_active === false) {
      const active = await query("SELECT COUNT(*) AS c FROM admin_users WHERE role='super_admin' AND is_active=1");
      if (Number(active[0].c) <= 1) return res.status(409).json({ error: '不能停用最后一个启用的超级管理员' });
    }
    fields.push('is_active=?'); values.push(req.body.is_active ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  values.push(id);
  fields.push('token_version=token_version+1');
  await query(`UPDATE admin_users SET ${fields.join(',')} WHERE id=?`, values);
  await audit(req.admin.username, 'update_admin', 'admin', id, req.body);
  res.json({ ok: true });
});
app.post('/api/admins/:id/reset-password', auth, async (req, res) => {
  const id = Number(req.params.id);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: '管理员 ID 无效' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: '密码长度须为 12-200 个字符' });
  const hash = await bcrypt.hash(password, 12);
  const result = await query('UPDATE admin_users SET password_hash=?,token_version=token_version+1 WHERE id=?', [hash, id]);
  if (!result.affectedRows) return res.status(404).json({ error: '管理员不存在' });
  await audit(req.admin.username, 'reset_admin_password', 'admin', id, {});
  res.json({ ok: true });
});

app.get('/api/dashboard', auth, async (req, res) => {
  const [users] = await query('SELECT COUNT(*) c FROM users');
  const [wallets] = await query('SELECT COUNT(*) c FROM wallets WHERE is_active=1');
  const [pending] = await query("SELECT COUNT(*) c FROM recharge_orders WHERE status='pending'");
  const [orders] = await query("SELECT COUNT(*) c FROM energy_orders WHERE status IN ('pending_provider','processing')");
  res.json({ stats: { '用户数': users.c, '监听地址数': wallets.c, '待审核充值': pending.c, '待处理能量订单': orders.c } });
});
app.get('/api/finance-audit', auth, async (req, res) => {
  try {
    const report = await runFinanceAudit();
    await audit(req.admin.username, 'run_finance_audit', 'finance_audit', null, { ok: report.ok, counts: report.counts });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: '财务审计运行失败', detail: e.message });
  }
});

app.post('/api/deposit-address-pool/import', auth, async (req, res) => {
  const raw = String(req.body?.addresses || '');
  const addresses = raw.split(/[\r\n,\s]+/).map(x => x.trim()).filter(Boolean);
  if (!addresses.length) return res.status(400).json({ error: '请至少填写一个地址，每行一个' });
  if (addresses.length > 5000) return res.status(400).json({ error: '单次最多导入 5000 个地址' });
  const result = await importDepositAddresses(addresses, String(req.body?.source_label || 'admin-import'));
  if (result.invalid.length) return res.status(400).json({ error: '发现格式无效的地址，未导入任何地址', invalid: result.invalid.slice(0, 20) });
  await audit(req.admin.username, 'import_deposit_address_pool', 'deposit_address_pool', null, result);
  res.json({ ok: true, ...result });
});
app.get('/api/deposit-address-pool', auth, async (req, res) => {
  const [counts] = await query("SELECT SUM(status='available') available_count,SUM(status='assigned') assigned_count,SUM(status='disabled') disabled_count FROM deposit_address_pool");
  const rows = await query('SELECT id,address,status,source_label,assigned_user_id,assigned_wallet_id,assigned_at,created_at FROM deposit_address_pool ORDER BY id DESC LIMIT 500');
  res.json({ available_count: Number(counts.available_count || 0), assigned_count: Number(counts.assigned_count || 0), disabled_count: Number(counts.disabled_count || 0), rows });
});
app.post('/api/deposit-address-pool/assign/:userId', auth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: '用户 ID 无效' });
  try {
    const result = await assignNextDepositAddress(userId);
    if (result.reason === 'pool_empty') return res.status(409).json({ error: '充值地址池为空，请先导入地址' });
    await audit(req.admin.username, 'assign_from_address_pool', 'wallet', result.wallet_id || result.id, { user_id: userId, address: result.address, existing: !!result.existing });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/wallets/deposit-address', auth, async (req, res) => {
  const userId = Number(req.body?.user_id);
  const address = String(req.body?.address || '').trim();
  const label = String(req.body?.label || '专属充值地址').trim().slice(0, 100);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: '用户 ID 无效' });
  if (!validateAddress(address)) return res.status(400).json({ error: 'TRON 地址格式无效' });
  try {
    const users = await query('SELECT id FROM users WHERE id=?', [userId]);
    if (!users.length) return res.status(404).json({ error: '用户不存在' });
    const used = await query('SELECT id FROM wallets WHERE address=? LIMIT 1', [address]);
    if (used.length) return res.status(409).json({ error: '该地址已在系统中登记，不能重复分配' });
    const pooled = await query('SELECT id FROM deposit_address_pool WHERE address=? LIMIT 1', [address]);
    if (pooled.length) return res.status(409).json({ error: '该地址在充值地址池中，请使用地址池分配功能' });
    const result = await query("INSERT INTO wallets (user_id,address,label,wallet_type) VALUES (?,?,?,'deposit')", [userId, address, label || '专属充值地址']);
    await audit(req.admin.username, 'assign_deposit_address', 'wallet', result.insertId, { user_id: userId, address });
    res.json({ ok: true, wallet_id: result.insertId, user_id: userId, address });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '地址已被分配' });
    res.status(500).json({ error: '分配地址失败' });
  }
});

app.post('/api/deposits/manual', auth, async (req, res) => {
  const userId = Number(req.body?.user_id);
  const amountText = String(req.body?.amount ?? '');
  const note = String(req.body?.note || '管理员手动创建，等待审核').slice(0, 500);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: '用户 ID 无效' });
  if (!/^\d{1,20}(?:\.\d{1,6})?$/.test(amountText) || Number(amountText) <= 0) return res.status(400).json({ error: '金额必须大于 0，最多 6 位小数' });
  const users = await query('SELECT id FROM users WHERE id=?', [userId]);
  if (!users.length) return res.status(404).json({ error: '用户不存在' });
  const result = await query("INSERT INTO recharge_orders (user_id,amount,currency,source,status,note) VALUES (?,?,'USDT','manual','pending',?)", [userId, amountText, note]);
  await audit(req.admin.username, 'create_manual_recharge', 'recharge', result.insertId, { user_id: userId, amount: amountText, note });
  res.json({ ok: true, id: result.insertId, status: 'pending' });
});

app.get('/api/deposits', auth, async (req, res) => {
  const status = req.query.status || 'pending';
  res.json(await query(
    `SELECT id,user_id,amount,currency,source,status,tx_hash,chain_verified_at,created_at FROM recharge_orders WHERE status=? ORDER BY id DESC LIMIT 200`, [status]
  ));
});
// V2.3: verify a TRON recharge against a confirmed on-chain TRC20 event.
// Verification never credits the balance; the existing manual approval remains separate.
app.post('/api/deposits/:id/verify-chain', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '无效充值订单 ID' });
  try {
    if (!process.env.TRON_USDT_CONTRACT) throw new Error('未配置 TRON_USDT_CONTRACT，拒绝验证');
    const rows = await query(
      `SELECT r.id,r.user_id,r.wallet_id,r.tx_hash,r.event_index,r.amount,r.currency,r.source,r.status,
              w.address AS deposit_address
         FROM recharge_orders r LEFT JOIN wallets w ON w.id=r.wallet_id
        WHERE r.id=? LIMIT 1`, [id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: '充值订单不存在' });
    if (order.source !== 'tron' || !order.tx_hash || !order.wallet_id || !order.deposit_address) {
      throw new Error('该订单不是关联专属充值地址的链上充值单，不能自动进行链上核验');
    }
    if (String(order.currency).toUpperCase() !== 'USDT') throw new Error('仅支持 USDT 充值核验');
    const events = await getConfirmedTrc20Transfer(order.tx_hash);
    const verification = verifyDepositTransfer(events, {
      contract: process.env.TRON_USDT_CONTRACT,
      to: order.deposit_address,
      amount: String(order.amount),
      decimals: Number(process.env.TRON_USDT_DECIMALS || 6)
    });
    if (verification.tx_hash && verification.tx_hash !== String(order.tx_hash).toLowerCase()) {
      throw new Error('链上事件交易哈希与充值订单不一致');
    }
    const report = {
      ...verification,
      recharge_order_id: order.id,
      user_id: order.user_id,
      wallet_id: order.wallet_id,
      verified_by: req.admin.username,
      verified_at: new Date().toISOString(),
      status_at_verification: order.status,
      note: '链上核验通过；此操作不会自动入账，仍需管理员单独审核。'
    };
    await query('UPDATE recharge_orders SET chain_verified_at=NOW(),chain_verified_json=? WHERE id=?',
      [JSON.stringify(report), id]);
    await audit(req.admin.username, 'verify_deposit_chain', 'recharge', id, report);
    res.json(report);
  } catch (e) {
    await audit(req.admin.username, 'verify_deposit_chain_failed', 'recharge', id, { error: e.message });
    res.status(422).json({ verified: false, error: e.message, balance_changed: false });
  }
});

app.post('/api/deposits/:id/approve', auth, async (req, res) => {
  try { const result = await creditRecharge(Number(req.params.id), req.admin.username); await audit(req.admin.username, 'approve_recharge', 'recharge', req.params.id, result); if (result.credited) { const users = await query('SELECT telegram_id FROM users WHERE id=?', [result.userId]); if (users[0]) await sendTelegramMessage(users[0].telegram_id, `充值已审核入账\n订单：${req.params.id}\n金额：${result.amount} USDT`); } res.json(result); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/deposits/:id/reject', auth, async (req, res) => {
  const result = await query(
    "UPDATE recharge_orders SET status='rejected',note=?,reviewed_by=?,reviewed_at=NOW() WHERE id=? AND status='pending'",
    [String(req.body?.note || '管理员拒绝').slice(0, 500), req.admin.username, Number(req.params.id)]
  );
  if (!result.affectedRows) return res.status(400).json({ error: '订单不存在或已处理' });
  await audit(req.admin.username, 'reject_recharge', 'recharge', req.params.id, { note: String(req.body?.note || '管理员拒绝').slice(0, 500) });
  res.json({ ok: true });
});
app.get('/api/deposit-wallets', auth, async (req, res) => {
  res.json(await query("SELECT id,user_id,address,label,last_scanned_at,created_at FROM wallets WHERE wallet_type='deposit' ORDER BY id DESC LIMIT 200"));
});
app.get('/api/audit-logs', auth, async (req, res) => {
  res.json(await query('SELECT id,admin_username,action,target_type,target_id,details_json,created_at FROM admin_audit_logs ORDER BY id DESC LIMIT 200'));
});

app.get('/api/users', auth, async (req, res) => {
  res.json(await query('SELECT id,telegram_id,username,balance,created_at FROM users ORDER BY id DESC LIMIT 200'));
});
app.get('/api/withdrawals', auth, async (req, res) => {
  const status = String(req.query.status || 'pending');
  const allowed = ['pending', 'approved', 'paid', 'rejected', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: '无效状态' });
  res.json(await query(
    `SELECT wr.id,wr.user_id,u.telegram_id,wr.amount,wr.currency,wr.destination_address,
            wr.status,wr.tx_hash,wr.reviewed_by,wr.reviewed_at,wr.note,wr.created_at
       FROM withdrawal_requests wr JOIN users u ON u.id=wr.user_id
      WHERE wr.status=? ORDER BY wr.id DESC LIMIT 200`, [status]
  ));
});

app.post('/api/withdrawals/:id/approve', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '无效订单 ID' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM withdrawal_requests WHERE id=? FOR UPDATE', [id]);
    const wr = rows[0];
    if (!wr || wr.status !== 'pending') throw new Error('提现单不存在或已处理');
    // Reserve funds and ledger posting are one transaction. A conditional debit
    // prevents a negative balance even if concurrent requests race.
    const posting = await postBalanceEntry(conn, {
      userId: Number(wr.user_id), delta: `-${String(wr.amount)}`,
      entryType: 'admin_adjustment', referenceType: 'withdrawal', referenceId: wr.id,
      idempotencyKey: `withdrawal-reserve:${wr.id}`,
      note: '提现批准，扣减可用余额；链上付款仍需人工完成'
    });
    if (!posting.posted) throw new Error('该提现单已有扣款账本记录但状态仍待处理，已停止操作，请先运行财务审计');
    await conn.execute(
      "UPDATE withdrawal_requests SET status='approved',reviewed_by=?,reviewed_at=NOW() WHERE id=?",
      [req.admin.username, wr.id]
    );
    await conn.commit();
    await audit(req.admin.username, 'withdrawal_approved', 'withdrawal', id, { amount: wr.amount, user_id: wr.user_id });
    res.json({ ok: true, status: 'approved', note: '已扣减可用余额；请人工完成链上转账后录入交易哈希。' });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

app.post('/api/withdrawals/:id/reject', auth, async (req, res) => {
  const id = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM withdrawal_requests WHERE id=? FOR UPDATE', [id]);
    const wr = rows[0];
    if (!wr || !['pending', 'approved'].includes(wr.status)) throw new Error('提现单不存在或状态不允许拒绝');
    if (wr.status === 'approved') {
      const refund = await postBalanceEntry(conn, {
        userId: Number(wr.user_id), delta: String(wr.amount), entryType: 'refund',
        referenceType: 'withdrawal', referenceId: wr.id,
        idempotencyKey: `withdrawal-refund:${wr.id}`, note: '提现取消，退回可用余额'
      });
      if (!refund.posted) throw new Error('该提现单已有退款账本记录但状态仍未拒绝，已停止操作，请先运行财务审计');
    }
    await conn.execute(
      "UPDATE withdrawal_requests SET status='rejected',reviewed_by=?,reviewed_at=NOW(),note=? WHERE id=?",
      [req.admin.username, req.body?.note ? String(req.body.note).slice(0, 500) : '管理员拒绝', id]
    );
    await conn.commit();
    await audit(req.admin.username, 'withdrawal_rejected', 'withdrawal', id, { previous_status: wr.status });
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

app.post('/api/withdrawals/:id/paid', auth, async (req, res) => {
  const id = Number(req.params.id);
  const txHash = String(req.body?.tx_hash || '').trim();
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '无效订单 ID' });
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: '请输入 64 位交易哈希' });
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM withdrawal_requests WHERE id=?', [id]);
    const wr = rows[0];
    if (!wr || wr.status !== 'approved') return res.status(409).json({ error: '订单不存在或未批准' });
    if (wr.currency !== 'USDT') return res.status(400).json({ error: '当前链上自动核验仅支持 USDT 提现' });
    const contractExpected = process.env.TRON_USDT_CONTRACT;
    if (!contractExpected) return res.status(503).json({ error: '未配置 TRON_USDT_CONTRACT，拒绝标记已付款' });

    // Fail closed: independently query confirmed TRON transaction and verify token contract,
    // destination, and exact raw token amount before any status change.
    const events = await getConfirmedTrc20Transfer(txHash);
    const match = matchWithdrawalTransfer(events, {
      contract: contractExpected,
      to: wr.destination_address,
      rawAmount: decimalToRaw(wr.amount, Number(process.env.TRON_USDT_DECIMALS || 6))
    });

    await conn.beginTransaction();
    const [lockedRows] = await conn.execute('SELECT * FROM withdrawal_requests WHERE id=? FOR UPDATE', [id]);
    const locked = lockedRows[0];
    if (!locked || locked.status !== 'approved') throw new Error('订单状态已变化，请刷新后重试');
    const [used] = await conn.execute('SELECT id FROM withdrawal_requests WHERE tx_hash=? AND id<>? LIMIT 1 FOR UPDATE', [txHash.toLowerCase(), id]);
    if (used.length) throw new Error('该交易哈希已用于其他提现单');
    const [updated] = await conn.execute("UPDATE withdrawal_requests SET status='paid',tx_hash=?,reviewed_by=?,reviewed_at=NOW(),chain_verified_at=NOW(),chain_verified_json=? WHERE id=? AND status='approved'", [txHash.toLowerCase(), req.admin.username, JSON.stringify({ contract: match.contract, from: match.from, to: match.to, rawAmount: match.rawAmount, blockTimestamp: match.blockTimestamp, receiptResult: match.receiptResult }), id]);
    if (!updated.affectedRows) throw new Error('提现状态已变化，请刷新后重试');
    await conn.execute(
      'INSERT INTO admin_audit_logs (admin_username,action,target_type,target_id,details_json,ip_address) VALUES (?,?,?,?,?,?)',
      [req.admin.username, 'withdrawal_chain_verified_paid', 'withdrawal', String(id), JSON.stringify({ tx_hash: txHash.toLowerCase(), contract: match.contract, to: match.to, raw_amount: match.rawAmount }), null]
    );
    await conn.commit();
    res.json({ ok: true, status: 'paid', chain_verified: true, tx_hash: txHash.toLowerCase() });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(400).json({ error: `链上核验未通过，提现未标记为已付款：${e.message}` });
  } finally { conn.release(); }
});

// Financial reconciliation: aggregates system records only; it does not independently
// prove blockchain settlement. Compare these reports with an external block explorer/provider.
app.get('/api/reconciliation/summary', auth, async (req, res) => {
  const from = String(req.query.from || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
  const to = String(req.query.to || new Date().toISOString().slice(0, 10));
  if (!validDateRange(from, to, 93)) return res.status(400).json({ error: '日期范围无效，最多查询 94 个自然日' });

  const [deposits] = await query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
       FROM recharge_orders WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [from, to]
  );
  const [credited] = await query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
       FROM recharge_orders WHERE status='credited' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [from, to]
  );
  const [pending] = await query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
       FROM recharge_orders WHERE status='pending' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [from, to]
  );
  const [rejected] = await query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
       FROM recharge_orders WHERE status='rejected' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [from, to]
  );
  const [withdrawals] = await query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
       FROM withdrawal_requests WHERE status IN ('approved','paid') AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [from, to]
  );
  const [ledger] = await query(
    `SELECT entry_type, COUNT(*) AS count, COALESCE(SUM(amount),0) AS net_amount
       FROM ledger_entries WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY entry_type ORDER BY entry_type`,
    [from, to]
  );
  res.json({
    period: { from, to },
    deposits: { count: Number(deposits.count), amount: deposits.amount },
    credited: { count: Number(credited.count), amount: credited.amount },
    pending: { count: Number(pending.count), amount: pending.amount },
    rejected: { count: Number(rejected.count), amount: rejected.amount },
    withdrawals_approved_or_paid: { count: Number(withdrawals.count), amount: withdrawals.amount },
    ledger_by_type: ledger,
    disclaimer: '这是系统数据库对账汇总，不是独立链上证明；请将 tx_hash 与 TRON 区块浏览器/可信节点记录核对。'
  });
});

app.post('/api/reconciliation/snapshot', auth, async (req, res) => {
  const from = String(req.body?.from || '');
  const to = String(req.body?.to || '');
  if (!validDateRange(from, to, 93)) return res.status(400).json({ error: '日期范围无效，最多查询 94 个自然日' });
  const [d] = await query(
    `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount FROM recharge_orders
     WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`, [from, to]);
  const [c] = await query(
    `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount FROM recharge_orders
     WHERE status='credited' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`, [from, to]);
  const [p] = await query(
    `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount FROM recharge_orders
     WHERE status='pending' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`, [from, to]);
  const [w] = await query(
    `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount FROM withdrawal_requests
     WHERE status IN ('approved','paid') AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`, [from, to]);
  const result = await query(
    `INSERT INTO reconciliation_runs
     (run_by,date_from,date_to,deposit_count,deposit_amount,credited_count,credited_amount,pending_count,pending_amount,withdrawal_count,withdrawal_amount)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.admin.username, from, to, d.count, d.amount, c.count, c.amount, p.count, p.amount, w.count, w.amount]
  );
  await audit(req.admin.username, 'create_reconciliation_snapshot', 'reconciliation', result.insertId, { from, to });
  res.json({ ok: true, id: result.insertId, from, to, deposits: d, credited: c, pending: p, withdrawals: w });
});

app.get('/api/reconciliation/snapshots', auth, async (req, res) => {
  res.json(await query('SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 100'));
});

app.get('/api/ledger/export.csv', auth, async (req, res) => {
  const from = String(req.query.from || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
  const to = String(req.query.to || new Date().toISOString().slice(0, 10));
  if (!validDateRange(from, to, 93)) return res.status(400).json({ error: '日期范围无效，最多查询 94 个自然日' });
  const rows = await query(
    `SELECT le.id,le.user_id,u.telegram_id,le.entry_type,le.amount,le.balance_after,
            le.reference_type,le.reference_id,le.idempotency_key,le.note,le.created_at
       FROM ledger_entries le JOIN users u ON u.id=le.user_id
      WHERE le.created_at >= ? AND le.created_at < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY le.id ASC LIMIT 50000`, [from, to]
  );
  const csv = toCsv(rows, [
    {key:'id',label:'ledger_id'}, {key:'user_id',label:'user_id'},
    {key:'telegram_id',label:'telegram_id'}, {key:'entry_type',label:'entry_type'},
    {key:'amount',label:'amount'}, {key:'balance_after',label:'balance_after'},
    {key:'reference_type',label:'reference_type'}, {key:'reference_id',label:'reference_id'},
    {key:'idempotency_key',label:'idempotency_key'}, {key:'note',label:'note'},
    {key:'created_at',label:'created_at'}
  ]);
  await audit(req.admin.username, 'export_ledger_csv', 'ledger', null, { from, to, rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ledger-${from}-${to}.csv"`);
  res.send('\\uFEFF' + csv);
});

// V1.6: compare indexed on-chain transfers against recharge records. This is
// diagnostic only: it never changes balances or automatically credits users.
// V1.7: bounded, resumable historical scan. It only indexes confirmed transfers and never credits balances.
app.post('/api/chain-backfill/run', auth, async (req, res) => {
  try {
    const from = String(req.body?.from || '');
    const to = String(req.body?.to || '');
    parseDateRange(from, to);
    const pagesPerWallet = Math.min(5, Math.max(1, Number(req.body?.pages_per_wallet || 3)));
    const result = await runBackfill({ from, to, admin: req.admin.username, pagesPerWallet });
    await audit(req.admin.username, 'run_chain_backfill', 'chain_backfill', null, { from, to, pagesPerWallet, results: result.results });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/chain-backfill/status', auth, async (req, res) => {
  res.json(await query(`SELECT s.id,s.wallet_id,w.address,s.from_timestamp,s.to_timestamp,s.status,s.pages_scanned,s.transfers_seen,s.last_error,s.started_by,s.created_at,s.updated_at
    FROM chain_backfill_state s JOIN wallets w ON w.id=s.wallet_id ORDER BY s.updated_at DESC LIMIT 200`));
});

app.post('/api/chain-alerts/run', auth, async (req, res) => {
  try {
    const result = await checkAndAlert();
    await audit(req.admin.username, 'run_chain_alerts', 'chain_alerts', null, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: '链上告警检查失败', detail: e.message }); }
});
app.get('/api/chain-alerts/recent', auth, async (req, res) => {
  const rows = await query(`SELECT id,alert_type,tx_hash,event_index,wallet_id,details_json,created_at
    FROM chain_alert_events ORDER BY id DESC LIMIT 100`);
  res.json(rows.map(r => ({ ...r, details_json: typeof r.details_json === 'string' ? JSON.parse(r.details_json) : r.details_json })));
});

app.get('/api/chain-audit', auth, async (req, res) => {
  const minDeposit = Math.max(0, Number(process.env.MIN_DEPOSIT || 1));
  const missing = await query(
    `SELECT t.id AS transaction_id,t.wallet_id,w.user_id,w.address AS deposit_address,
            t.tx_hash,t.event_index,t.amount,t.block_timestamp,t.from_address,t.to_address
       FROM transactions t JOIN wallets w ON w.id=t.wallet_id
       LEFT JOIN recharge_orders r ON r.wallet_id=t.wallet_id AND r.tx_hash=t.tx_hash AND r.event_index=t.event_index
      WHERE w.wallet_type='deposit' AND w.is_active=1
        AND LOWER(t.to_address)=LOWER(w.address) AND t.confirmed=1
        AND t.amount >= ? AND r.id IS NULL
      ORDER BY t.id DESC LIMIT 500`, [minDeposit]
  );
  const mismatch = await query(
    `SELECT t.id AS transaction_id,r.id AS recharge_order_id,t.wallet_id,w.user_id,
            t.tx_hash,t.event_index,t.amount AS chain_amount,r.amount AS order_amount,
            r.status AS recharge_status,t.block_timestamp
       FROM transactions t JOIN wallets w ON w.id=t.wallet_id
       JOIN recharge_orders r ON r.wallet_id=t.wallet_id AND r.tx_hash=t.tx_hash AND r.event_index=t.event_index
      WHERE w.wallet_type='deposit' AND w.is_active=1 AND LOWER(t.to_address)=LOWER(w.address)
        AND t.confirmed=1 AND ABS(t.amount-r.amount) > 0.000001
      ORDER BY t.id DESC LIMIT 500`
  );
  const orphaned = await query(
    `SELECT r.id AS recharge_order_id,r.user_id,r.wallet_id,r.tx_hash,r.event_index,r.amount,r.status,r.created_at
       FROM recharge_orders r LEFT JOIN transactions t
         ON t.wallet_id=r.wallet_id AND t.tx_hash=r.tx_hash AND t.event_index=r.event_index
      WHERE r.source='tron' AND r.tx_hash IS NOT NULL AND t.id IS NULL
      ORDER BY r.id DESC LIMIT 500`
  );
  await audit(req.admin.username, 'run_chain_audit', 'chain_audit', null, {
    missing: missing.length, amount_mismatch: mismatch.length, orphaned_recharge: orphaned.length
  });
  res.json({ generated_at: new Date().toISOString(), minimum_deposit: minDeposit,
    counts: { missing_recharge_order: missing.length, amount_mismatch: mismatch.length, orphaned_recharge_order: orphaned.length },
    missing_recharge_order: missing, amount_mismatch: mismatch, orphaned_recharge_order: orphaned,
    disclaimer: '只检查本系统已索引的交易记录，不能发现尚未被扫描到的链上交易；异常只报告，不自动改余额。请在区块浏览器/可信节点复核。' });
});

app.get('/api/commissions', auth, async (req, res) => {
  const rows = await query(
    `SELECT rc.id,rc.referrer_user_id,rc.referred_user_id,rc.recharge_order_id,
            rc.amount,rc.percent,rc.status,rc.created_at
       FROM referral_commissions rc ORDER BY rc.id DESC LIMIT 200`
  );
  res.json(rows);
});

app.get('/api/energy-orders', auth, async (req, res) => {
  res.json(await query('SELECT id,user_id,receiver_address,energy_amount,quoted_price,status,created_at FROM energy_orders ORDER BY id DESC LIMIT 200'));
});

module.exports = app;