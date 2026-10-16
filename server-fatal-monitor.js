'use strict';

// KRISTINE 2.0: diagnostic breadcrumbs without changing Node's default
// fatal-error / rejected-promise behavior or exposing business payloads.
const { createHash } = require('node:crypto');
const installed = new WeakSet();

function safeErrorType(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'Error';
}
function safeErrorCode(error) {
  const code = error?.code;
  const s = typeof code === 'string' ? code : typeof code === 'number' ? String(code) : '';
  return /^[A-Z0-9_]{1,32}$/.test(s) ? s : undefined;
}
function stackFingerprint(error) {
  const frames = String(error?.stack || '')
    .split('\n').slice(1, 7)
    .map(frame => frame.trim().replace(/:\d+(?::\d+)?/g, ':#'));
  return createHash('sha256').update(frames.join('\n')).digest('hex').slice(0, 16);
}
function installCrashDiagnostics({
  emitter = process,
  emit = line => process.stderr.write(line + '\n'),
  getUptime = () => Math.floor(process.uptime()),
} = {}) {
  if (installed.has(emitter)) return false;
  installed.add(emitter);
  const report = (kind, data) => {
    try { emit('[KRISTINE_FATAL] ' + JSON.stringify({ kind, uptimeSeconds: getUptime(), ...data })); }
    catch { /* Crash logging must never affect termination or exit status. */ }
  };
  emitter.on('uncaughtExceptionMonitor', (error, origin) => {
    report('uncaught', {
      origin: origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
      errorType: safeErrorType(error),
      ...(safeErrorCode(error) ? { errorCode: safeErrorCode(error) } : {}),
      stackFingerprint: stackFingerprint(error),
    });
  });
  emitter.on('exit', code => {
    if (code !== 0) report('exit', { exitCode: Number(code) });
  });
  return true;
}

// NODE_OPTIONS -r preload runs before server.js and every domain preload.
// Requiring this module in tests does not register listeners automatically.
if (process.argv[1] && /(?:^|[\\/])server\.js$/i.test(process.argv[1])) {
  installCrashDiagnostics();
}

module.exports = { installCrashDiagnostics, safeErrorType, safeErrorCode, stackFingerprint };
