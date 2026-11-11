const { signatureValid } = require('./eventSignature');
const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { getConfirmedTrc20Transfer, rawToDecimal } = require('./tron');
const { saveTransfer } = require('./monitor');
let io;
const status = { source: 'not_configured', lastEventAt: null, lastError: null };
function initSocket(server) {
  const { Server } = require('socket.io');
  io = new Server(server, { path: '/socket.io', cors: { origin: false }, transports: ['websocket', 'polling'] });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'tron-energy-bot', audience: 'tron-energy-admin' });
      if (!claims?.username) throw new Error('unauthorized');
      socket.data.claims = claims;
      next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', async socket => {
    try {
      const c = socket.data.claims;
      const rows = await query('SELECT role,is_active,token_version FROM admin_users WHERE username=? LIMIT 1', [c.username]);
      const a = rows[0];
      if (!a || !Number(a.is_active) || a.role !== c.role || Number(a.token_version || 0) !== Number(c.token_version || 0)) { socket.disconnect(true); return; }
      socket.join('admins');
      socket.emit('monitor:status', status);
    } catch { socket.disconnect(true); }
  });
  return io;
}
function publish(type, payload) { if (io) io.to('admins').emit(type, payload); }\nfunction closeSocket() {\n  if (!io) return Promise.resolve();\n  const current = io;\n  io = null;\n  return new Promise(resolve => current.close(() => resolve()));\n}
function getStatus() { return { ...status }; }
async function handleEvent(raw, signature) {
  if (!signatureValid(raw, signature, process.env.TRON_EVENT_WEBHOOK_SECRET)) throw Object.assign(new Error('invalid signature'), { status: 401 });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
  if (body.network !== 'mainnet' || !/^[a-f0-9]{64}$/i.test(String(body.txHash || ''))) throw Object.assign(new Error('invalid event'), { status: 400 });
  // Incoming event is only a hint. Never trust amounts, confirmations or addresses from the sender.
  const txHash = body.txHash.toLowerCase();
  const transfers = await getConfirmedTrc20Transfer(txHash);
  const contract = String(process.env.TRON_USDT_CONTRACT || '');
  if (!contract) throw new Error('TRON_USDT_CONTRACT must be configured');
  let saved = 0;
  for (let index = 0; index < transfers.length; index++) {
    const t = transfers[index];
    if (t.contract.toLowerCase() !== contract.toLowerCase() || !/^\d+$/.test(t.rawAmount) || BigInt(t.rawAmount) <= 0n) continue;
    const wallets = await query('SELECT * FROM wallets WHERE is_active=1 AND (LOWER(address)=? OR LOWER(address)=?)', [t.from.toLowerCase(), t.to.toLowerCase()]);
    for (const wallet of wallets) {
      const record = { txHash, eventIndex: index, contract: t.contract, from: t.from, to: t.to, amount: rawToDecimal(t.rawAmount, Number(process.env.TRON_USDT_DECIMALS || 6)), blockTimestamp: t.blockTimestamp, confirmed: true, type: 'trc20' };
      const inserted = await saveTransfer(wallet, record, 'trc20');
      if (inserted) { saved++; publish('tron:transfer', { walletId: wallet.id, txHash, amount: record.amount, from: t.from, to: t.to, token: 'USDT', confirmed: true }); }
    }
  }
  status.source = 'webhook'; status.lastEventAt = new Date().toISOString(); status.lastError = null;
  publish('monitor:status', getStatus());
  return { accepted: true, saved };
}
module.exports = { initSocket, handleEvent, getStatus, signatureValid, publish };
