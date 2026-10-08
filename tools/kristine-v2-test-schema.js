'use strict';

/**
 * One-time schema initialization for the NEW, isolated KRISTINE 2.0 test DB.
 * Never called without an explicit test-only environment flag and the exact
 * database name check. Never truncates data or overwrites existing tables.
 */
const fs = require('node:fs');
const path = require('node:path');
const {TEST_DB_NAME}=require('../storage/kristine-v2-sql-read-model');

const MIGRATIONS = Object.freeze(Array.from({length:26},(_,i)=>String(i+1).padStart(3,'0')));

async function testSchemaState(client) {
  const result = (await client.query(
    "SELECT current_database() AS db, to_regclass('kristine.projects')::text AS projects, " +
    "to_regclass('kristine_storage.documents')::text AS docs, " +
    "to_regclass('kristine.external_dataset_files')::text AS external_files, " +
    "to_regclass('kristine.imported_company_rule_models')::text AS models"
  )).rows[0];
  return result;
}

async function initializeTestSchema(pool, {
  expectedDatabase=TEST_DB_NAME,
  migrationsDir=path.resolve(__dirname,'..','migrations'),
} = {}) {
  if(typeof pool?.connect !== 'function') throw new TypeError('Database pool required');
  const client=await pool.connect();
  let invalid=false;
  try {
    const state=await testSchemaState(client);
    if(state?.db!==expectedDatabase) throw new Error('Unexpected database identity: test initialization denied');

    if (state.projects || state.docs || state.external_files || state.models) {
      if(state.projects && state.docs && state.external_files && state.models) {
        return {state:'already_initialized',migrationsApplied:0};
      }
      throw new Error('Partial schema detected; manual review required before any further migration');
    }

    const files=fs.readdirSync(migrationsDir).filter(name=>/^\d{3}-[^/]+\.sql$/.test(name)).sort();
    const expected=MIGRATIONS.map(prefix=>{
      const matches=files.filter(name=>name.startsWith(prefix+'-'));
      if(matches.length!==1)throw new Error('Missing or duplicate schema migration '+prefix);
      return matches[0];
    });
    if(files.length!==expected.length)throw new Error('Unreviewed extra SQL migration present');

    for(const filename of expected) {
      // Every migration is already transactionally wrapped in BEGIN/COMMIT.
      // Do not retry after any partial run; later starts fail closed.
      const sql=fs.readFileSync(path.join(migrationsDir,filename),'utf8');
      try { await client.query(sql); }
      catch(error) { invalid=true;throw error; }
    }

    const done=await testSchemaState(client);
    if(!done.projects||!done.docs||!done.external_files||!done.models)
      throw new Error('Test schema verification failed');
    return {state:'initialized',migrationsApplied:expected.length};
  } finally {
    client.release(invalid);
  }
}

module.exports={initializeTestSchema,testSchemaState,MIGRATIONS};
