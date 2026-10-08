'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {initializeTestSchema,MIGRATIONS}=require('../tools/kristine-v2-test-schema');

const poolFor=db=>({
  connect:async()=>({
    query:(sql,args)=>sql.startsWith('BEGIN;')?db.exec(sql):db.query(sql,args),
    release(){}
  }),
});

test('test-only schema initialization applies each of 26 versions once',async()=>{
  const db=new PGlite();
  try{
    const expected=(await db.query('SELECT current_database() AS db')).rows[0].db;
    assert.equal(MIGRATIONS.length,26);
    const result=await initializeTestSchema(poolFor(db),{expectedDatabase:expected});
    assert.deepEqual(result,{state:'initialized',migrationsApplied:26});
    assert.equal((await db.query("SELECT to_regclass('kristine.projects')::text AS name")).rows[0].name,'kristine.projects');
    assert.equal((await db.query("SELECT count(*)::int n FROM kristine.source_records")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM kristine.time_events")).rows[0].n,0);
    const again=await initializeTestSchema(poolFor(db),{expectedDatabase:expected});
    assert.deepEqual(again,{state:'already_initialized',migrationsApplied:0});
  }finally{await db.close();}
});

test('wrong database name and partially installed schema are rejected',async()=>{
  const db=new PGlite();
  try{
    await assert.rejects(initializeTestSchema(poolFor(db)),/Unexpected database identity/);
    await db.exec(fs.readFileSync(__dirname+'/../migrations/001-document-store.sql','utf8'));
    const expected=(await db.query('SELECT current_database() AS db')).rows[0].db;
    await assert.rejects(initializeTestSchema(poolFor(db),{expectedDatabase:expected}),/Partial schema/);
  }finally{await db.close();}
});
