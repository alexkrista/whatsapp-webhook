'use strict';

class StorageConflict extends Error {
  constructor() { super('Storage revision conflict'); this.code = 'STORAGE_CONFLICT'; }
}
const keyValid = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.includes('\0');
const revisionValid = revision => typeof revision === 'string' && /^(0|[1-9][0-9]*)$/.test(revision) && BigInt(revision) < 9223372036854775807n;

// Pool is supplied by the caller. Importing this module never connects or selects a backend.
function createPostgresDocumentStore(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required');
  async function readMany(keys) {
    if (!Array.isArray(keys) || keys.some(key => !keyValid(key)) || new Set(keys).size !== keys.length) throw new TypeError('Invalid storage keys');
    // One statement provides one PostgreSQL snapshot for all requested documents.
    const result = await pool.query('SELECT document_key, payload, revision::text FROM kristine_storage.documents WHERE document_key = ANY($1::text[])', [keys]);
    const found = new Map(result.rows.map(row => [row.document_key, { value: row.payload, revision: row.revision }]));
    return keys.map(key => ({ key, ...(found.get(key) || { value: undefined, revision: '0' }) }));
  }
  async function writeBatch(changes) {
    if (!Array.isArray(changes) || changes.length === 0 || changes.some(change => !change || !keyValid(change.key) || !revisionValid(change.expectedRevision)) || new Set(changes.map(change => change.key)).size !== changes.length) throw new TypeError('Invalid storage changes');
    // Freeze caller values before asynchronous work; no undefined/null ambiguity for missing documents.
    const encoded = changes.map(change => {
      const payload = JSON.stringify(change.value);
      if (payload === undefined) throw new TypeError('A JSON value is required');
      return { key: change.key, expectedRevision: change.expectedRevision, payload };
    }).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const client = await pool.connect();
    let active = false;
    try {
      await client.query('BEGIN'); active = true;
      const revisions = [];
      for (const change of encoded) {
        const result = change.expectedRevision === '0'
          ? await client.query('INSERT INTO kristine_storage.documents (document_key, payload) VALUES ($1, $2::jsonb) ON CONFLICT (document_key) DO NOTHING RETURNING revision::text', [change.key, change.payload])
          : await client.query('UPDATE kristine_storage.documents SET payload = $2::jsonb, revision = revision + 1, updated_at = clock_timestamp() WHERE document_key = $1 AND revision = $3::bigint RETURNING revision::text', [change.key, change.payload, change.expectedRevision]);
        if (result.rows.length !== 1) throw new StorageConflict();
        revisions.push({ key: change.key, revision: result.rows[0].revision });
      }
      await client.query('COMMIT'); active = false;
      return revisions;
    } catch (error) {
      if (active) { try { await client.query('ROLLBACK'); } catch { /* Keep original error; destroy connection below. */ } }
      throw error;
    } finally { client.release(active); }
  }
  return { readMany, writeBatch };
}
module.exports = { createPostgresDocumentStore, StorageConflict };
