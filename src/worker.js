'use strict';

require('dotenv').config();

const { pool } = require('./db');
const { createDurableQueue } = require('./durableQueue');
const { getConfirmedTrc20Transfer } = require('./tron');
const { saveTransfer } = require('./monitor');

const queue = createDurableQueue({ pool });
let stopping = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processTronWebhook(job) {
  const inboxId = Number(job.payload?.inboxId);
  const txHash = String(job.payload?.txHash || '').toLowerCase();
  if (!Number.isSafeInteger(inboxId) || inboxId <= 0 || !/^[a-f0-9]{64}$/.test(txHash)) {
    throw Object.assign(new Error('INVALID_WEBHOOK_JOB'), { code: 'INVALID_WEBHOOK_JOB' });
  }

  const [events] = await pool.execute(
    "SELECT id,network,event_type,status,payload_json,signature_valid FROM event_inbox WHERE id=? LIMIT 1",
    [inboxId]
  );
  const event = events[0];
  if (!event || Number(event.signature_valid) !== 1 || event.network !== 'mainnet' ||
      event.event_type !== 'trc20.transfer') {
    throw Object.assign(new Error('INVALID_INBOX_EVENT'), { code: 'INVALID_INBOX_EVENT' });
  }
  let payload = event.payload_json;
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (String(payload?.txHash || '').toLowerCase() !== txHash) {
    throw Object.assign(new Error('INBOX_PAYLOAD_MISMATCH'), { code: 'INBOX_PAYLOAD_MISMATCH' });
  }

  await pool.execute(
    "UPDATE event_inbox SET status='processing',attempts=attempts+1 WHERE id=? AND status<>'processed'",
    [inboxId]
  );

  // Webhook data is only a hint. All transfer details are fetched from confirmed chain data.
  const transfers = await getConfirmedTrc20Transfer(txHash);
  const contract = String(process.env.TRON_USDT_CONTRACT || '').toLowerCase();
  if (!contract) throw Object.assign(new Error('TRON_USDT_CONTRACT_MISSING'), { code: 'TRON_USDT_CONTRACT_MISSING' });
  const decimals = Number(process.env.TRON_USDT_DECIMALS || 6);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw Object.assign(new Error('TRON_USDT_DECIMALS_INVALID'), { code: 'TRON_USDT_DECIMALS_INVALID' });
  }

  let saved = 0;
  for (let index = 0; index < transfers.length; index++) {
    const transfer = transfers[index];
    if (String(transfer.contract).toLowerCase() !== contract ||
        !/^\d+$/.test(String(transfer.rawAmount)) || BigInt(transfer.rawAmount) <= 0n ||
        Number(transfer.decimals) !== decimals) continue;
    const [wallets] = await pool.execute(
      'SELECT * FROM wallets WHERE is_active=1 AND (LOWER(address)=? OR LOWER(address)=?)',
      [String(transfer.from).toLowerCase(), String(transfer.to).toLowerCase()]
    );
    for (const wallet of wallets) {
      const { rawToDecimal } = require('./tron');
      const record = {
        txHash, eventIndex: index, contract: transfer.contract,
        from: transfer.from, to: transfer.to,
        amount: rawToDecimal(transfer.rawAmount, decimals),
        blockTimestamp: transfer.blockTimestamp,
        confirmed: true, type: 'trc20'
      };
      if (await saveTransfer(wallet, record, 'trc20')) saved++;
    }
  }

  await pool.execute(
    "UPDATE event_inbox SET status='processed',processed_at=UTC_TIMESTAMP(3),last_error_code=NULL WHERE id=?",
    [inboxId]
  );
  return { saved };
}

async function handleJob(job) {
  if (job.job_type === 'tron.webhook.process') return processTronWebhook(job);
  throw Object.assign(new Error('UNSUPPORTED_JOB_TYPE'), { code: 'UNSUPPORTED_JOB_TYPE' });
}

async function runWorker({ pollMs = Number(process.env.WORKER_POLL_MS || 1000) } = {}) {
  console.log('[worker] durable job worker started');
  while (!stopping) {
    let job;
    try {
      job = await queue.claimJob({ leaseSeconds: 90 });
      if (!job) { await sleep(pollMs); continue; }
      try {
        const result = await handleJob(job);
        const completed = await queue.completeJob({ id: job.id, leaseToken: job.lease_token });
        if (!completed) throw Object.assign(new Error('JOB_LEASE_LOST'), { code: 'JOB_LEASE_LOST' });
        console.log('[worker] job completed', job.id, JSON.stringify(result));
      } catch (error) {
        await queue.failJob({ id: job.id, leaseToken: job.lease_token, error });
        if (job.job_type === 'tron.webhook.process' && job.payload?.inboxId) {
          const [rows] = await pool.execute(
            'SELECT attempts,max_attempts,status FROM background_jobs WHERE id=? LIMIT 1', [job.id]
          );
          const dead = rows[0] && Number(rows[0].attempts) >= Number(rows[0].max_attempts);
          await pool.execute(
            'UPDATE event_inbox SET status=?,last_error_code=? WHERE id=? AND status<>"processed"',
            [dead ? 'dead' : 'failed', /^[A-Z0-9_]{1,80}$/.test(String(error.code || '')) ? error.code : 'JOB_FAILED', job.payload.inboxId]
          );
        }
        console.error('[worker] job failed', job.id, error.code || 'JOB_FAILED');
      }
    } catch (error) {
      console.error('[worker] queue error:', error.code || error.message);
      await sleep(Math.min(10000, pollMs * 5));
    }
  }
  console.log('[worker] stopping');
}

function stopWorker() { stopping = true; }

if (require.main === module) {
  const { closePool } = require('./db');
  const stop = async signal => {
    stopWorker();
    console.log('[worker] received', signal);
    const timer = setTimeout(() => process.exit(1), 15000);
    try { await closePool(); } catch (error) { console.error('[worker] database close failed'); }
    clearTimeout(timer);
  };
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  runWorker().catch(async error => {
    console.error('[worker] fatal error:', error.message);
    process.exitCode = 1;
    stopWorker();
    await closePool().catch(() => {});
  });
}

module.exports = { runWorker, stopWorker, processTronWebhook };
