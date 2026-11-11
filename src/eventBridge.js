const { signatureValid } = require('./eventSignature');
const jwt = require('jsonwebtoken');
const { query } = require('./db');
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
function publish(type, payload) { if (io) io.to('admins').emit(type, payload); }
function closeSocket() {
  if (!io) return Promise.resolve();
  const current = io;
  io = null;
  return new Promise(resolve => current.close(() => resolve()));
}
function getStatus() { return { ...status }; }
async function handleEvent(raw, signature) {
  // The HTTP request only authenticates and durably records the event.
  // Chain RPC and all financial side effects run in the separate worker.
  const accepted = await require('./eventInbox').acceptWebhook(raw, signature);
  status.source = 'webhook';
  status.lastEventAt = new Date().toISOString();
  status.lastError = null;
  publish('monitor:status', getStatus());
  return accepted;
}

module.exports = { initSocket, closeSocket, handleEvent, getStatus, signatureValid, publish };
