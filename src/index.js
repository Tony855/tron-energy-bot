'use strict';

require('dotenv').config();

const app = require('./web');
const { fork } = require('node:child_process');
const path = require('node:path');
const { createBot } = require('./bot');
const { initSocket, closeSocket, publish } = require('./eventBridge');
const { pool, closePool } = require('./db');
const { createOutbox } = require('./outbox');
const { dispatchOutboxOnce } = require('./outboxDispatcher');
const { loadConfig } = require('./config');
const { assertV4Schema } = require('./schemaGuard');
const { createWorkerSupervisor, updateWorkerHealth } = require('./workerSupervisor');

let server;
let bot;
let workerProcess;
let shuttingDown = false;
let shutdownTimeoutMs = 15000;
let socketOutboxPromise;
const socketOutbox = createOutbox({ pool });
const workerSupervisor = createWorkerSupervisor({
  spawnWorker: () => fork(path.join(__dirname, 'worker.js'), [], { stdio: 'inherit' }),
  maxRestarts: Number(process.env.WORKER_MAX_RESTARTS || 5),
  baseDelayMs: Number(process.env.WORKER_RESTART_BASE_MS || 1000),
  maxDelayMs: Number(process.env.WORKER_RESTART_MAX_MS || 30000),
  onStatus: updateWorkerHealth
});

function listen(httpServer, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      httpServer.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.removeListener('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, host);
  });
}

async function configureBotCommands(instance) {
  if (!instance) return;
  const { t, SUPPORTED } = require('./i18n');
  const commands = ['start', 'balance', 'wallets', 'addwallet', 'deposit', 'withdraw',
    'transactions', 'status', 'report', 'referral', 'help', 'language'];
  const telegramLanguage = { 'zh-CN': 'zh', en: 'en' };
  const buildCommands = lang => commands.map(command => ({ command, description: t(lang, 'cmd.' + command) }));
  for (const lang of SUPPORTED) {
    const tg = telegramLanguage[lang];
    if (!tg) continue;
    try {
      await instance.api.setMyCommands(buildCommands(lang), { language_code: tg });
    } catch (error) {
      console.error('[bot] setMyCommands(' + tg + ') failed:', error.message);
    }
  }
}

async function dispatchSocketOutbox() {
  while (!shuttingDown) {
    try {
      const worked = await dispatchOutboxOnce({
        outbox: socketOutbox,
        eventType: 'socket.emit',
        deliver: async item => {
          const eventName = String(item.payload?.eventName || '');
          if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(eventName)) {
            throw Object.assign(new Error('INVALID_SOCKET_EVENT'), { code: 'INVALID_SOCKET_EVENT' });
          }
          publish(eventName, item.payload?.data || {});
        },
        logger: console
      });
      if (!worked) await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error('[outbox] socket dispatcher error:', error.code || error.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function shutdown(signal = 'shutdown') {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExitTimer = setTimeout(() => {
    console.error('[lifecycle] graceful shutdown deadline exceeded; forcing process exit');
    process.exit(1);
  }, shutdownTimeoutMs);
  console.log('[lifecycle] ' + signal + ': graceful shutdown started');

  if (bot) {
    try { await bot.stop(); }
    catch (error) { console.error('[lifecycle] bot stop failed:', error.message); }
  }

  if (socketOutboxPromise) await socketOutboxPromise.catch(() => {});

  workerSupervisor.stop();
  workerProcess = workerSupervisor.getChild();
  if (workerProcess && workerProcess.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { workerProcess.kill('SIGKILL'); } catch {}
        resolve();
      }, Math.min(10000, shutdownTimeoutMs));
      workerProcess.once('exit', () => { clearTimeout(timer); resolve(); });
      try { workerProcess.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
    workerProcess = null;
  }

  try { await closeSocket(); }
  catch (error) { console.error('[lifecycle] socket close failed:', error.message); }

  if (server && server.listening) {
    await new Promise(resolve => server.close(error => {
      if (error) console.error('[lifecycle] HTTP close failed:', error.message);
      resolve();
    }));
  }

  try { await closePool(); }
  catch (error) { console.error('[lifecycle] database close failed:', error.message); }

  clearTimeout(forceExitTimer);
  console.log('[lifecycle] shutdown complete');
}

async function main() {
  const config = loadConfig();
  shutdownTimeoutMs = config.shutdownTimeoutMs;
  await pool.query('SELECT 1');
  await assertV4Schema(pool);

  server = require('node:http').createServer(app);
  initSocket(server);
  await listen(server, config.port, config.host);
  console.log('[web] listening on ' + config.host + ':' + config.port);

  // Keep durable webhook processing isolated from the HTTP request lifecycle.
  socketOutboxPromise = dispatchSocketOutbox();
  workerSupervisor.start();
  workerProcess = workerSupervisor.getChild();

  bot = createBot();
  await configureBotCommands(bot);
  if (bot) {
    console.log('[bot] starting polling...');
    bot.start().then(() => {
      console.log('[bot] polling stopped');
    }).catch(error => {
      if (!shuttingDown) {
        console.error('[bot] polling failed:', error.message);
        process.exitCode = 1;
        void shutdown('telegram-polling-error');
      }
    });
  }

  console.log('[events] waiting for authenticated provider webhooks; no TronGrid polling');
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

main().catch(async error => {
  console.error('[startup] failed:', error.message);
  process.exitCode = 1;
  await shutdown('startup-error');
});
