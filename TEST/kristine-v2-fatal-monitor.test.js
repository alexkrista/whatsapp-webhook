'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  installCrashDiagnostics,
  safeErrorType,
  safeErrorCode,
} = require('../server-fatal-monitor');

test('monitor reports fatal context but never logs an exception message or stack', () => {
  const emitter = new EventEmitter();
  const lines = [];
  assert.equal(installCrashDiagnostics({ emitter, emit: x => lines.push(x), getUptime: () => 42 }), true);
  assert.equal(installCrashDiagnostics({ emitter, emit: x => lines.push(x) }), false);
  assert.equal(emitter.listenerCount('uncaughtExceptionMonitor'), 1);
  assert.equal(emitter.listenerCount('uncaughtException'), 0);
  assert.equal(emitter.listenerCount('unhandledRejection'), 0);
  const error = new Error('SECRET_TOKEN=never-log-me');
  error.code = 'ECONNRESET';
  emitter.emit('uncaughtExceptionMonitor', error, 'unhandledRejection');
  emitter.emit('exit', 1);
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0].replace('[KRISTINE_FATAL] ', ''));
  const second = JSON.parse(lines[1].replace('[KRISTINE_FATAL] ', ''));
  assert.equal(first.kind, 'uncaught');
  assert.equal(first.origin, 'unhandledRejection');
  assert.equal(first.errorType, 'Error');
  assert.equal(first.errorCode, 'ECONNRESET');
  assert.equal(first.stackFingerprint.length, 16);
  assert.equal(first.uptimeSeconds, 42);
  assert.deepEqual(second, { kind: 'exit', uptimeSeconds: 42, exitCode: 1 });
  assert.doesNotMatch(lines.join('\n'), /SECRET_TOKEN|never-log-me|stack":|C:\\/);
});
test('monitor does not log a normal exit or trust arbitrary error identifiers', () => {
  const emitter = new EventEmitter(), lines = [];
  installCrashDiagnostics({ emitter, emit: s => lines.push(s), getUptime: () => 9 });
  emitter.emit('exit', 0);
  assert.equal(lines.length, 0);
  assert.equal(safeErrorType({ name: 'Error password=x' }), 'Error');
  assert.equal(safeErrorCode({ code: 'SECRET=password' }), undefined);
});
test('monitor cannot change exit behavior if log sink itself fails', () => {
  const emitter = new EventEmitter();
  installCrashDiagnostics({ emitter, emit: () => { throw new Error('write failure'); } });
  assert.doesNotThrow(() => {
    emitter.emit('uncaughtExceptionMonitor', new Error('failure'), 'uncaughtException');
    emitter.emit('exit', 1);
  });
});
