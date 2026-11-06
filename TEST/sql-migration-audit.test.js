'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { audit } = require('../tools/sql-migration-audit');
test('inventory includes hidden project metadata and JSONL without changing or exposing payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sql-audit-'));
  try {
    await fs.mkdir(path.join(root, '26001'));
    const payload = '[{"secret":"private-business-value"}]';
    await fs.writeFile(path.join(root, 'time-events.json'), payload);
    await fs.writeFile(path.join(root, '26001', '.meta.json'), '{"jobId":"26001"}');
    await fs.writeFile(path.join(root, 'events.jsonl'), '{}\n{}\n');
    const report = await audit(root);
    assert.equal(report.ready, true);
    assert.equal(report.consistentSnapshot, false);
    assert.equal(report.files.length, 3);
    assert.equal(report.files.find(f => f.path === 'events.jsonl').records, 2);
    assert.equal(JSON.stringify(report).includes('private-business-value'), false);
    assert.equal(await fs.readFile(path.join(root, 'time-events.json'), 'utf8'), payload);
    assert.deepEqual(await audit(root), report);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('invalid JSON, JSONL and encoding block preflight', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sql-audit-'));
  try {
    await fs.writeFile(path.join(root, 'bad.json'), '{');
    await fs.writeFile(path.join(root, 'bad.jsonl'), '{}\nnope');
    await fs.writeFile(path.join(root, 'encoding.json'), Buffer.from([255]));
    const report = await audit(root);
    assert.equal(report.ready, false);
    assert.ok(report.files.every(f => !f.valid));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('symlinks are not followed and empty source is not ready', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sql-audit-'));
  try {
    assert.equal((await audit(root)).ready, false);
    await fs.symlink(root, path.join(root, 'loop'));
    const report = await audit(root);
    assert.equal(report.ready, false);
    assert.deepEqual(report.skipped, [{ path: 'loop', reason: 'symlink' }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
