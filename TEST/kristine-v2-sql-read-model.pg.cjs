'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {readSqlOverview,verifyTestDatabaseUrl,CUTOFF}=require('../storage/kristine-v2-sql-read-model');

const goodUrl='postgresql://kristine_2_0_test_db_user:password@dpg-db3u5cui0phs73eaa700-a/kristine_2_0_test_db';
const allow=a=>a&&a.length>0;
const poolFor=(db,queries=[])=>({
  connect:async()=>({
    query:async(sql,args)=>{queries.push({sql,args});return db.query(sql,args);},
    release:()=>{},
  }),
});

test('KRISTINE 2.0 accepts its own Render TEST database only',()=>{
  assert.equal(CUTOFF,'2026-10-01');
  assert.equal(verifyTestDatabaseUrl(goodUrl),goodUrl);
  for(const bad of [
    '', 'https://example.org',
    'postgresql://kristine_postgres_user:password@dpg-db2e70ek1f9s73a4q4ig-a/kristine_postgres',
    'postgresql://kristine_2_0_test_db_user:password@evil.example/kristine_2_0_test_db',
    'postgresql://other:password@dpg-db3u5cui0phs73eaa700-a/kristine_2_0_test_db',
    'postgresql://kristine_2_0_test_db_user:password@dpg-db3u5cui0phs73eaa700-a/kristine_postgres',
    'postgresql://kristine_2_0_test_db_user@dpg-db3u5cui0phs73eaa700-a/kristine_2_0_test_db',
  ]) assert.throws(()=>verifyTestDatabaseUrl(bad));
});

test('empty SQL database is explicitly distinguished from a populated one',async()=>{
  const db=new PGlite();
  try {
    assert.equal((await readSqlOverview(poolFor(db))).state,'schema_missing');
    await db.exec(fs.readFileSync(__dirname+'/../migrations/002-domain-core.sql','utf8'));
    assert.equal((await readSqlOverview(poolFor(db))).state,'empty_database');
  }finally{await db.close();}
});

test('populated read-only SQL summary uses real rows, keeps zeroes and excludes September events',async()=>{
  const db=new PGlite(),queries=[];
  try{
    await db.exec(fs.readFileSync(__dirname+'/../migrations/002-domain-core.sql','utf8'));
    await db.exec(fs.readFileSync(__dirname+'/../migrations/026-obelisk-read-only-boundary.sql','utf8'));
    const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('Testbetrieb') RETURNING id")).rows[0].id;
    const employeeId=(await db.query(
      "INSERT INTO kristine.employees(company_id,display_name,active) VALUES($1,'Test Mitarbeiter',true) RETURNING id",
      [companyId])).rows[0].id;
    await db.query("INSERT INTO kristine.employee_external_ids(company_id,employee_id,namespace,external_id) VALUES($1,$2,'finkzeit','023')",[companyId,employeeId]);
    const projectId=(await db.query(
      "INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES($1,'00042','Projekt & Test',3) RETURNING id",
      [companyId])).rows[0].id;
    for(const date of ['2026-09-30','2026-10-01']){
      await db.query(
        "INSERT INTO kristine.time_events(company_id,employee_id,project_id,work_date,event_type,origin,rule_version,booked_time) VALUES($1,$2,$3,$4,'start','kgo','existing-rule','07:00')",
        [companyId,employeeId,projectId,date]);
    }
    await db.query("INSERT INTO kristine.assignments(company_id,employee_id,project_id,work_date,activity_code) VALUES($1,$2,$3,'2026-10-01','work')",[companyId,employeeId,projectId]);
    await db.query("INSERT INTO kristine.documents(company_id,document_type,title) VALUES($1,'pdf','Testdokument')",[companyId]);
    const si=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[companyId])).rows[0].id;
    await db.query("INSERT INTO kristine.import_runs(company_id,source_instance_id,status) VALUES($1,$2,'validated')",[companyId,si]);

    const model=await readSqlOverview(poolFor(db,queries));
    assert.equal(model.state,'ready');
    assert.equal(model.company.name,'Testbetrieb');
    assert.deepEqual(model.counts,{
      projects:1,employees:1,assignments:1,
      time_events_since_cutoff:1,document_records:1,validated_imports:1,
    });
    assert.deepEqual(model.projects,[{number:'00042',name:'Projekt & Test',status:3}]);
    assert.deepEqual(model.employees,[{name:'Test Mitarbeiter',active:true,personalNumber:'023'}]);
    assert.deepEqual(model.sources,[{system:'kristine',validatedRuns:1}]);
    assert.equal(queries[0].sql,'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    assert.equal(queries.at(-1).sql,'COMMIT');
    assert.ok(queries.slice(1,-1).every(q=>q.sql.trimStart().startsWith('SELECT')));
    assert.ok(queries.slice(1,-1).every(q=>!/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(q.sql)));
    assert.ok(queries.some(q=>q.sql.includes("work_date >= DATE '2026-10-01'")));
  }finally{await db.close();}
});

test('several companies require explicit selection; cannot silently cross company boundaries',async()=>{
  const db=new PGlite();
  try{
    await db.exec(fs.readFileSync(__dirname+'/../migrations/002-domain-core.sql','utf8'));
    await db.exec("INSERT INTO kristine.companies(name) VALUES('A'),('B')");
    assert.equal((await readSqlOverview(poolFor(db))).state,'company_selection_required');
  }finally{await db.close();}
});
