'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH || '@electric-sql/pglite');
const { createPostgresDocumentStore } = require('../storage/postgres-document-store');

test('PostgreSQL core schema and integrity', async t => {
  const db = new PGlite();
  const q = (sql, values) => db.query(sql, values);
  async function rejectsSQL(sql, values, message) {
    await q('SAVEPOINT expected_failure');
    let error;
    try { await q(sql, values); } catch (e) { error = e; }
    await q('ROLLBACK TO SAVEPOINT expected_failure');
    await q('RELEASE SAVEPOINT expected_failure');
    assert.ok(error, 'Expected database rejection');
    if (message) assert.match(error.message, message);
  }
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/002-domain-core.sql'),'utf8'));
    const a = (await q("INSERT INTO kristine.companies(name) VALUES ('A') RETURNING id")).rows[0].id;
    const b = (await q("INSERT INTO kristine.companies(name) VALUES ('B') RETURNING id")).rows[0].id;
    const e = (await q("INSERT INTO kristine.employees(company_id,display_name) VALUES ($1,'Test') RETURNING id",[a])).rows[0].id;
    const project = (await q("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES ($1,'00023','Büro',2) RETURNING id",[a])).rows[0].id;
    const foreignProject = (await q("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES ($1,'00023','Foreign',2) RETURNING id",[b])).rows[0].id;
    const s = (await q("INSERT INTO kristine.time_segments(company_id,employee_id,project_id,work_date,activity_code,origin,payroll_minutes,productive_minutes,break_minutes,rule_version) VALUES ($1,$2,$3,'2026-10-06','work','manual',468,450,15,'existing-v1') RETURNING id",[a,e,project])).rows[0].id;
    const makeClose = async () => (await q("INSERT INTO kristine.payroll_month_closes(company_id,employee_id,month_start,employee_name_snapshot,rule_version,calculation_rules_snapshot,payroll_minutes,productive_minutes,break_minutes) VALUES ($1,$2,'2026-10-01','Test','existing-v1','{\"fixture\":\"existing-v1\"}',468,450,15) RETURNING id",[a,e])).rows[0].id;
    const copySnapshot = async close => q("INSERT INTO kristine.payroll_snapshot_segments(company_id,employee_id,close_id,source_segment_id,source_revision,work_date,activity_code,project_number_snapshot,project_name_snapshot,starts_at,ends_at,payroll_minutes,productive_minutes,break_minutes,rule_version) SELECT s.company_id,s.employee_id,$1,s.id,s.revision,s.work_date,s.activity_code,p.project_number,p.name,s.starts_at,s.ends_at,s.payroll_minutes,s.productive_minutes,s.break_minutes,s.rule_version FROM kristine.time_segments s LEFT JOIN kristine.projects p ON p.id=s.project_id WHERE s.id=$2",[close,s]);
    const finish = close => q("UPDATE kristine.payroll_month_closes SET status='closed',closed_at=clock_timestamp(),closed_by='test' WHERE id=$1",[close]);
    const isolated = async (name,fn) => t.test(name, async () => { await q('BEGIN'); try { await fn(); } finally { await q('ROLLBACK'); } });

    await isolated('32 core tables, business identifiers retain leading zeros', async () => {
      assert.equal((await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='kristine'")).rows[0].n,32);
      await q("INSERT INTO kristine.employee_external_ids VALUES ($1,$2,'finkzeit','0026')",[a,e]);
      assert.equal((await q('SELECT external_id FROM kristine.employee_external_ids')).rows[0].external_id,'0026');
      await rejectsSQL("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES ($1,'00023','Duplicate',2)",[a]);
    });
    await isolated('cross-company references and invalid project status fail', async () => {
      await rejectsSQL('UPDATE kristine.time_segments SET project_id=$1 WHERE id=$2',[foreignProject,s]);
      await rejectsSQL('UPDATE kristine.projects SET status=6 WHERE id=$1',[project]);
    });
    await isolated('source IDs are unique per source instance and source versions preserve raw history', async () => {
      const si = (await q("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES ($1,'winworker','ww-main') RETURNING id",[a])).rows[0].id;
      const ri = (await q("INSERT INTO kristine.import_runs(company_id,source_instance_id) VALUES ($1,$2) RETURNING id",[a,si])).rows[0].id;
      const sr = (await q("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES ($1,$2,'project','00023') RETURNING id",[a,si])).rows[0].id;
      await rejectsSQL("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES ($1,$2,'project','00023')",[a,si]);
      await q('INSERT INTO kristine.external_references(company_id,source_record_id,project_id) VALUES ($1,$2,$3)',[a,sr,project]);
      await rejectsSQL('UPDATE kristine.external_references SET employee_id=$1 WHERE source_record_id=$2',[e,sr]);
      await q("INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,source_sha256) VALUES ($1,$2,$3,$4,'{}',$5)",[a,si,sr,ri,'a'.repeat(64)]);
      await rejectsSQL("UPDATE kristine.source_record_versions SET raw_payload='null'",[],/append-only/);
    });
    await isolated('empty snapshots and false totals cannot close a populated month', async () => {
      const c = await makeClose();
      await rejectsSQL("UPDATE kristine.payroll_month_closes SET status='closed',closed_at=clock_timestamp(),closed_by='test' WHERE id=$1",[c],/incomplete or stale/);
      await copySnapshot(c);
      await rejectsSQL("UPDATE kristine.payroll_month_closes SET status='closed',closed_at=clock_timestamp(),closed_by='test',payroll_minutes=1 WHERE id=$1",[c],/totals differ/);
    });
    await isolated('stale snapshots fail and closure is atomic', async () => {
      const c = await makeClose(); await copySnapshot(c);
      await q('UPDATE kristine.time_segments SET payroll_minutes=480 WHERE id=$1',[s]);
      await rejectsSQL("UPDATE kristine.payroll_month_closes SET status='closed',closed_at=clock_timestamp(),closed_by='test' WHERE id=$1",[c],/incomplete or stale/);
      assert.equal((await q('SELECT status FROM kristine.payroll_month_closes WHERE id=$1',[c])).rows[0].status,'draft');
    });
    await isolated('snapshot source values cannot be fabricated', async () => {
      const c = await makeClose(); await copySnapshot(c);
      await rejectsSQL('UPDATE kristine.payroll_snapshot_segments SET payroll_minutes=1 WHERE close_id=$1',[c],/values differ/);
      await rejectsSQL("UPDATE kristine.payroll_snapshot_segments SET project_number_snapshot='wrong' WHERE close_id=$1",[c],/project differs/);
      await rejectsSQL("UPDATE kristine.payroll_snapshot_segments SET work_date='2026-11-01' WHERE close_id=$1",[c],/month mismatch/);
    });
    await isolated('closed snapshots remain unchanged after project time corrections or deletion', async () => {
      const c = await makeClose(); await copySnapshot(c); await finish(c);
      await q('UPDATE kristine.time_segments SET payroll_minutes=500, productive_minutes=480 WHERE id=$1',[s]);
      assert.equal((await q('SELECT payroll_minutes::text FROM kristine.payroll_snapshot_segments WHERE close_id=$1',[c])).rows[0].payroll_minutes,'468.0000');
      assert.equal((await q('SELECT revision::text FROM kristine.time_segments WHERE id=$1',[s])).rows[0].revision,'2');
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.time_segment_revisions WHERE segment_id=$1',[s])).rows[0].n,2);
      await rejectsSQL('UPDATE kristine.payroll_snapshot_segments SET payroll_minutes=0 WHERE close_id=$1',[c],/immutable/);
      await rejectsSQL('DELETE FROM kristine.payroll_snapshot_segments WHERE close_id=$1',[c],/immutable/);
      await rejectsSQL("UPDATE kristine.payroll_month_closes SET status='draft',closed_at=NULL,closed_by=NULL WHERE id=$1",[c],/immutable/);
      await rejectsSQL('DELETE FROM kristine.payroll_month_closes WHERE id=$1',[c],/immutable/);
      await q('DELETE FROM kristine.time_segments WHERE id=$1',[s]);
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.payroll_snapshot_segments WHERE close_id=$1',[c])).rows[0].n,1);
      await rejectsSQL('TRUNCATE kristine.payroll_snapshot_segments',[],/append-only/);
    });
    await isolated('legacy time is excluded from new live payroll closes', async () => {
      await q("UPDATE kristine.time_segments SET origin='legacy' WHERE id=$1",[s]);
      const c = await makeClose();
      await q('UPDATE kristine.payroll_month_closes SET payroll_minutes=0,productive_minutes=0,break_minutes=0 WHERE id=$1',[c]);
      await finish(c);
      assert.equal((await q('SELECT status FROM kristine.payroll_month_closes WHERE id=$1',[c])).rows[0].status,'closed');
    });
    await isolated('month keys and direct closed inserts are rejected', async () => {
      await rejectsSQL("INSERT INTO kristine.time_month_locks VALUES ($1,$2,'2026-10-06')",[a,e]);
      await rejectsSQL("INSERT INTO kristine.payroll_month_closes(company_id,employee_id,month_start,status,employee_name_snapshot,rule_version,calculation_rules_snapshot,payroll_minutes,productive_minutes,break_minutes,closed_at,closed_by) VALUES ($1,$2,'2026-10-01','closed','Test','v1','{}',0,0,0,clock_timestamp(),'test')",[a,e],/inserted as draft/);
    });
    await isolated('time event history cannot be rewritten', async () => {
      await q("INSERT INTO kristine.time_events(company_id,employee_id,work_date,event_type,origin,rule_version) VALUES ($1,$2,'2026-10-06','start','kgo','v1')",[a,e]);
      await rejectsSQL("UPDATE kristine.time_events SET event_type='ende'",[],/append-only/);
      await rejectsSQL('DELETE FROM kristine.time_events',[],/append-only/);
    });
    await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/001-document-store.sql'),'utf8'));
    await t.test('document store CAS and batch rollback execute on PostgreSQL', async () => {
      const store = createPostgresDocumentStore({ query:q, connect:async () => ({query:q,release:()=>{}}) });
      await store.writeBatch([{key:'a',value:{n:1},expectedRevision:'0'},{key:'b',value:[],expectedRevision:'0'}]);
      await assert.rejects(store.writeBatch([{key:'a',value:{n:2},expectedRevision:'1'},{key:'b',value:[1],expectedRevision:'99'}]),{code:'STORAGE_CONFLICT'});
      assert.deepEqual(await store.readMany(['a','b']),[{key:'a',value:{n:1},revision:'1'},{key:'b',value:[],revision:'1'}]);
      await assert.rejects(store.writeBatch([{key:'a',value:null,expectedRevision:'0'}]),{code:'STORAGE_CONFLICT'});
    });
  } finally { await db.close(); }
});
