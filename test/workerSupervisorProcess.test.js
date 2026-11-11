'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createWorkerSupervisor } = require('../src/workerSupervisor');

test('worker supervisor restarts a real child process after unexpected exit', {
  timeout: 5000
}, async () => {
  let spawnCount = 0;
  let resolveRunning;
  const running = new Promise(resolve => { resolveRunning = resolve; });
  const supervisor = createWorkerSupervisor({
    spawnWorker: () => {
      spawnCount += 1;
      const code = spawnCount === 1
        ? 'setTimeout(() => process.exit(17), 30)'
        : 'setInterval(() => {}, 1000)';
      return spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    },
    maxRestarts: 1, baseDelayMs: 100, maxDelayMs: 100,
    onStatus: state => {
      if (state.status === 'running' && state.restarts === 1) resolveRunning();
    },
    logger: { error() {} }
  });
  supervisor.start();
  try {
    await running;
    assert.equal(spawnCount, 2);
    const child = supervisor.getChild();
    assert.ok(child);
    supervisor.stop();
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  } finally {
    supervisor.stop();
    const child = supervisor.getChild();
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
});
