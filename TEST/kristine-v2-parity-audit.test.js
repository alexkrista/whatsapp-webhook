'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { auditParity, trackedFile, registeredRoutes, isApprovedBlob } =
  require('../tools/kristine-v2-parity-audit');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/kristine-2-0-kgo-baseline.json'), 'utf8'));
const source = rel => trackedFile(root, rel);

test('unchanged KGO including day-close keeps its six frozen source files', () => {
  const result = auditParity({ root });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.protectedFiles, 6);
  assert.equal(result.requiredServerContracts, 11);
  assert.equal(result.requiredClientPaths, 9);
  assert.ok(result.totalStaticRouteRegistrations >= 11);
  assert.match(result.baseCommit, /^[a-f0-9]{40}$/);
});

test('a changed KGO click handler fails the parity gate without modifying source', () => {
  const result = auditParity({
    manifest,
    readText: rel => rel === 'public/kristine-go.js'
      ? source(rel) + '\n// changed UI behaviour\n' : source(rel)
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('KGO file changed: public/kristine-go.js'));
});

test('removing a required time-write endpoint is detected independently of frozen UI files', () => {
  const original = source('kristine.js');
  assert.match(original, /app\.put\("\/kristine\/api\/segments\/:employeeId\/:date"/);
  const changed = original.replace(
    'app.put("/kristine/api/segments/:employeeId/:date"',
    'app.put("/__test_intentionally_missing_segments"',
  );
  const result = auditParity({
    manifest,
    readText: rel => rel === 'kristine.js' ? changed : source(rel)
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('Missing server contract: PUT /kristine/api/segments/:employeeId/:date'));
});

test('route parser includes endpoint methods and rejects unrelated dot-get calls', () => {
  const routes = registeredRoutes(
    'app.get("/kristine/api/bootstrap", handler);\n' +
    'app.post("/kristine/api/message", handler);\n' +
    'object.get("/not-a-route", handler);'
  );
  assert.deepEqual(routes, [
    { method: 'GET', path: '/kristine/api/bootstrap' },
    { method: 'POST', path: '/kristine/api/message' },
  ]);
});

test('CRLF checkout does not trigger a false positive, substantive change does', () => {
  const text = 'one\ntwo\n';
  const blob = require('../tools/kristine-v2-parity-audit').gitBlobSha1(text);
  assert.equal(isApprovedBlob('one\r\ntwo\r\n', blob), true);
  assert.equal(isApprovedBlob('one\nthree\n', blob), false);
});
