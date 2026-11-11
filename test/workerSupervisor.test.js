'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkerSupervisor } = require('../src/workerSupervisor');

function harness(options = {}) {
  const children = [], timers = [], states = [];
  const supervisor = createWorkerSupervisor({
    spawnWorker() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    },
    schedule(fn, delay) { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel(timer) { timer.cancelled = true; },
    onStatus: state => states.push(state),
    logger: { error() {} },
    ...options
  });
  return { supervisor, children, timers, states };
}

test('worker supervisor restarts unexpected exits with bounded backoff', () => {
  const h = harness({ maxRestarts: 3, baseDelayMs: 100, maxDelayMs: 250 });
  h.supervisor.start();
  h.children[0].emit('spawn');
  h.children[0].emit('exit', 1, null);
  assert.equal(h.states.at(-1).status, 'restarting');
  assert.equal(h.timers[0].delay, 100);
  h.timers[0].fn();
  h.children[1].emit('spawn');
  h.children[1].emit('exit', 1, null);
  assert.equal(h.timers[1].delay, 200);
  h.timers[1].fn();
  assert.equal(h.children.length, 3);
});

test('worker supervisor opens circuit after maximum restart attempts', () => {
  const h = harness({ maxRestarts: 1, baseDelayMs: 10 });
  h.supervisor.start();
  h.children[0].emit('exit', 1, null);
  h.timers[0].fn();
  h.children[1].emit('exit', 1, null);
  assert.equal(h.states.at(-1).status, 'failed');
  assert.equal(h.timers.length, 1);
});

test('worker supervisor does not restart after intentional stop', () => {
  const h = harness();
  h.supervisor.start();
  h.children[0].emit('spawn');
  h.supervisor.stop();
  h.children[0].emit('exit', 0, 'SIGTERM');
  assert.equal(h.timers.length, 0);
  assert.equal(h.states.at(-1).status, 'stopped');
});

test('worker supervisor bounds synchronous spawn failures', () => {
  let calls = 0;
  const timers = [], states = [];
  const supervisor = createWorkerSupervisor({
    spawnWorker() { calls += 1; throw new Error('spawn failed'); },
    maxRestarts: 1,
    schedule(fn, delay) { const t = { fn, delay }; timers.push(t); return t; },
    cancel() {},
    onStatus: state => states.push(state),
    logger: { error() {} }
  });
  supervisor.start();
  timers[0].fn();
  assert.equal(calls, 2);
  assert.equal(states.at(-1).status, 'failed');
});
