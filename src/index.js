'use strict';

require('dotenv').config();

const app = require('./web');
const { fork } = require('node:child_process');
const path = require('node:path');
const { createBot } = require('./bot');
const { initSocket, closeSocket } = require('./eventBridge');
const { pool, closePool } = require('./db');
const { loadConfig } = require('./config');

let server;
let bot;
let workerProcess;
let shuttingDown = false;
let shutdownTimeoutMs = 15000;

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

  server = require('node:http').createServer(app);
  initSocket(server);
  await listen(server, config.port, config.host);
  console.log('[web] listening on ' + config.host + ':' + config.port);

  // Keep durable webhook processing isolated from the HTTP request lifecycle.
  workerProcess = fork(path.join(__dirname, 'worker.js'), [], { stdio: 'inherit' });
  workerProcess.on('error', error => {
    console.error('[worker] process error:', error.message);
    process.exitCode = 1;
  });
  workerProcess.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error('[worker] exited unexpectedly:', code, signal || '');
      process.exitCode = 1;
    }
  });

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
