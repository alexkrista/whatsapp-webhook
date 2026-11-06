'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPostgresDocumentStore } = require('../storage/postgres-document-store');
function fixture(reply = () => ({ rows: [{ revision: '1' }] })) {
  const calls = [], released = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return reply(sql, params); }, release: broken => released.push(broken) };
  const pool = { connect: async () => client, query: client.query };
  return { store: createPostgresDocumentStore(pool), calls, released };
}
test('multi-document write uses one transaction, stable order and parameterized payloads', async () => {
  const f = fixture();
  const changes = [{ key: 'states.json', expectedRevision: '3', value: { x: "'); DROP TABLE x; --" } }, { key: 'events.json', expectedRevision: '0', value: [] }];
  const pending = f.store.writeBatch(changes);
  changes[0].value.x = 'changed';
  await pending;
  assert.equal(f.calls[0].sql, 'BEGIN');
  assert.equal(f.calls[1].params[0], 'events.json');
  assert.equal(f.calls[2].params[0], 'states.json');
  assert.equal(JSON.parse(f.calls[2].params[1]).x, "'); DROP TABLE x; --");
  assert.ok(f.calls.every(c => !c.sql.includes('DROP TABLE')));
  assert.equal(f.calls.at(-1).sql, 'COMMIT');
  assert.deepEqual(f.released, [false]);
});
test('stale revision after earlier write aborts whole transaction and does not commit', async () => {
  const f = fixture((sql, params) => ({ rows: sql.startsWith('UPDATE') && params[0] === 'z' ? [] : [{ revision: '2' }] }));
  await assert.rejects(f.store.writeBatch([{ key: 'a', expectedRevision: '1', value: {} }, { key: 'z', expectedRevision: '1', value: {} }]), { code: 'STORAGE_CONFLICT' });
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!f.calls.some(c => c.sql === 'COMMIT'));
  assert.deepEqual(f.released, [true]);
});
test('database error propagates, rollback is attempted and failed connection is discarded', async () => {
  const failure = new Error('test transport failure');
  const f = fixture(sql => { if (sql.startsWith('INSERT') || sql === 'ROLLBACK') throw failure; return { rows: [] }; });
  await assert.rejects(f.store.writeBatch([{ key: 'a', expectedRevision: '0', value: null }]), error => error === failure);
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.deepEqual(f.released, [true]);
});
test('invalid values, duplicates and unsafe revisions are rejected before SQL', async () => {
  const f = fixture();
  for (const changes of [[], [{ key: 'a', expectedRevision: '-1', value: 1 }], [{ key: 'a', expectedRevision: '9223372036854775807', value: 1 }], [{ key: 'a', expectedRevision: '0', value: undefined }], [{ key: 'a', expectedRevision: '0', value: 1 }, { key: 'a', expectedRevision: '0', value: 2 }]]) await assert.rejects(f.store.writeBatch(changes));
  assert.equal(f.calls.length, 0);
});
test('one read statement distinguishes missing documents from JSON null and keeps bigint revisions exact', async () => {
  const f = fixture(() => ({ rows: [{ document_key: 'null', payload: null, revision: '9007199254740993' }] }));
  assert.deepEqual(await f.store.readMany(['missing', 'null']), [{ key: 'missing', value: undefined, revision: '0' }, { key: 'null', value: null, revision: '9007199254740993' }]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, [['missing', 'null']]);
});
