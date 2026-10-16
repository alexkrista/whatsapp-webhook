'use strict';

// Read-only static gate: no network, credentials, databases, HTTP requests or writes.
// This deliberately protects only the initial KGO contract. Full business
// feature parity requires additional integration and end-to-end tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_PATH = 'docs/kristine-2-0-kgo-baseline.json';

function gitBlobSha1(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1')
    .update('blob ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');
}
function isApprovedBlob(actualText, expectedSha1) {
  // Windows worktrees may convert checkout LF to CRLF without modifying Git objects.
  return gitBlobSha1(actualText) === expectedSha1 ||
    gitBlobSha1(actualText.replace(/\r\n/g, '\n')) === expectedSha1;
}
function trackedFile(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath ||
      relativePath.startsWith('/') || relativePath.includes('\\') ||
      relativePath.split('/').some(part => part === '..' || part === '.' || !part)) {
    throw new Error('Unsafe relative path');
  }
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}
function registeredRoutes(source) {
  const found = [];
  const rx = /\bapp\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(rx)) {
    if (m[2].startsWith('/')) found.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return found;
}
function auditParity({
  root = path.resolve(__dirname, '..'),
  manifest = null,
  readText = null,
} = {}) {
  const source = readText || (rel => trackedFile(root, rel));
  const baseline = manifest || JSON.parse(source(MANIFEST_PATH));
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.protectedFiles) ||
      !Array.isArray(baseline.requiredServerRoutes) ||
      !Array.isArray(baseline.serverRouteFiles) ||
      !Array.isArray(baseline.requiredClientPaths)) throw new Error('Unrecognized parity manifest');

  const errors = [];
  for (const file of baseline.protectedFiles) {
    try {
      if (!isApprovedBlob(source(file.path), file.gitBlobSha1)) errors.push('KGO file changed: ' + file.path);
    } catch (e) { errors.push('KGO file unreadable: ' + file.path); }
  }

  const routeDefinitions = [];
  for (const filename of baseline.serverRouteFiles) {
    try {
      for (const item of registeredRoutes(source(filename))) routeDefinitions.push({ ...item, file: filename });
    } catch { errors.push('Route source missing: ' + filename); }
  }
  const available = new Set(routeDefinitions.map(item => item.method + ' ' + item.path));
  for (const route of baseline.requiredServerRoutes) {
    if (!available.has(route.method + ' ' + route.path)) {
      errors.push('Missing server contract: ' + route.method + ' ' + route.path);
    }
  }

  const clientSource = baseline.protectedFiles
    .filter(file => file.path === 'public/kristine-go.js' || file.path === 'public/kristine-go-abschluss.html')
    .map(file => {
      try { return source(file.path); }
      catch { return ''; }
    }).join('\n');
  for (const prefix of baseline.requiredClientPaths) {
    if (!clientSource.includes(prefix)) errors.push('Missing KGO API usage: ' + prefix);
  }

  const duplicates = [];
  for (const route of baseline.requiredServerRoutes) {
    const count = routeDefinitions.filter(found => found.method === route.method && found.path === route.path).length;
    if (count > 1) duplicates.push({ method: route.method, path: route.path, definitions: count });
  }
  return {
    ok: errors.length === 0,
    baseCommit: baseline.productionCommit,
    protectedFiles: baseline.protectedFiles.length,
    requiredServerContracts: baseline.requiredServerRoutes.length,
    totalStaticRouteRegistrations: routeDefinitions.length,
    requiredClientPaths: baseline.requiredClientPaths.length,
    duplicateRouteDefinitions: duplicates,
    errors,
  };
}

if (require.main === module) {
  try {
    const result = auditParity();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch (e) {
    // Avoid echoing raw paths or project data when this static check fails.
    process.stderr.write('KRISTINE 2.0 parity audit could not complete.\n');
    process.exitCode = 2;
  }
}
module.exports = { auditParity, trackedFile, gitBlobSha1, isApprovedBlob, registeredRoutes };
