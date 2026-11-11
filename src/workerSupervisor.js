'use strict';

const health = { status: 'starting', restarts: 0, lastExitCode: null, lastSignal: null };

function createWorkerSupervisor({
  spawnWorker, maxRestarts = 5, baseDelayMs = 1000, maxDelayMs = 30000,
  schedule = setTimeout, cancel = clearTimeout, onStatus = () => {}, logger = console
}) {
  if (typeof spawnWorker !== 'function') throw new TypeError('spawnWorker is required');
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) throw new TypeError('maxRestarts must be a non-negative integer');
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 100 || !Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new TypeError('worker restart delays are invalid');
  let child = null, timer = null, stopped = true, generation = 0, restarts = 0;

  function setStatus(status, extra = {}) {
    const snapshot = { status, restarts, ...extra };
    onStatus(snapshot);
  }

  function handleFailure(currentGeneration, exit, error) {
    if (stopped || currentGeneration !== generation) return;
    const extra = {
      lastExitCode: exit?.code ?? null,
      lastSignal: exit?.signal ?? null,
      lastError: error ? 'WORKER_SPAWN_FAILED' : undefined
    };
    logger.error('[worker] exited unexpectedly:', error?.message || exit?.code, exit?.signal || '');
    if (restarts >= maxRestarts) { setStatus('failed', extra); return; }
    restarts += 1;
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (restarts - 1)));
    setStatus('restarting', { ...extra, nextRestartInMs: delay });
    timer = schedule(() => { timer = null; launch(); }, delay);
  }

  function launch() {
    if (stopped) return;
    const currentGeneration = ++generation;
    setStatus('starting');
    let process;
    try { process = spawnWorker(); }
    catch (error) { handleFailure(currentGeneration, null, error); return; }
    child = process;
    let settled = false;
    process.once('spawn', () => {
      if (!stopped && currentGeneration === generation) setStatus('running');
    });
    process.once('error', error => {
      if (settled) return;
      settled = true;
      if (child === process) child = null;
      logger.error('[worker] process error:', error.message);
      handleFailure(currentGeneration, null, error);
    });
    process.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (child === process) child = null;
      handleFailure(currentGeneration, { code, signal });
    });
  }

  return {
    start() { if (stopped) { stopped = false; restarts = 0; launch(); } },
    stop() {
      stopped = true; generation += 1;
      if (timer) { cancel(timer); timer = null; }
      setStatus('stopped');
    },
    getChild() { return child; }
  };
}

function getWorkerHealth() { return { ...health }; }
function updateWorkerHealth(snapshot) { Object.assign(health, snapshot); }

module.exports = { createWorkerSupervisor, getWorkerHealth, updateWorkerHealth };
