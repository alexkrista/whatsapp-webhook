'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH || '@electric-sql/pglite');

test('OBELISK stays an external read-only source across every SQL import path', async () => {
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(__dirname + '/../migrations/002-domain-core.sql', 'utf8'));
    await db.exec(fs.readFileSync(__dirname + '/../migrations/026-obelisk-read-only-boundary.sql', 'utf8'));
    const companyId = (await db.query("INSERT INTO kristine.companies(name) VALUES('Test') RETURNING id")).rows[0].id;
    const makeInstance = async systemCode =>
      (await db.query('INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,$2,$3) RETURNING id', [companyId,systemCode,systemCode])).rows[0].id;
    const obelisk = await makeInstance('obelisk');
    const kriszeit = await makeInstance('kristine');
    const legacy = await makeInstance('winworker');

    // OBELISK may remain visible as a source reference for the historical reader.
    assert.equal((await db.query('SELECT system_code FROM kristine.source_instances WHERE id=$1', [obelisk])).rows[0].system_code, 'obelisk');

    // A direct import-run or direct raw-source insert is prohibited at the database layer.
    await assert.rejects(db.query(
      'INSERT INTO kristine.import_runs(company_id,source_instance_id) VALUES($1,$2)',
      [companyId,obelisk]), /OBELISK.*read-only/);
    await assert.rejects(db.query(
      "INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'employee','001')",
      [companyId,obelisk]), /OBELISK.*read-only/);

    // No one may rename an existing imported source into OBELISK, or vice versa.
    await assert.rejects(db.query(
      "UPDATE kristine.source_instances SET system_code='obelisk' WHERE id=$1",
      [kriszeit]), /OBELISK.*identity/);
    await assert.rejects(db.query(
      "UPDATE kristine.source_instances SET system_code='kristine' WHERE id=$1",
      [obelisk]), /OBELISK.*identity/);

    // KRISZEIT and authorised WinWorker sources remain usable.
    const runId = (await db.query(
      'INSERT INTO kristine.import_runs(company_id,source_instance_id) VALUES($1,$2) RETURNING id',
      [companyId,kriszeit])).rows[0].id;
    const rowId = (await db.query(
      "INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'employee','001') RETURNING id",
      [companyId,kriszeit])).rows[0].id;
    const content = '{"id":"001","date":"2026-10-01"}';
    const sha = require('node:crypto').createHash('sha256').update(content).digest('hex');
    await db.query(
      'INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5,$5,$6)',
      [companyId,kriszeit,rowId,runId,content,sha]);
    await db.query("UPDATE kristine.import_runs SET status='validated', finished_at=clock_timestamp() WHERE id=$1", [runId]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kristine.source_record_versions')).rows[0].n,1);
    const wwRun = (await db.query('INSERT INTO kristine.import_runs(company_id,source_instance_id) VALUES($1,$2) RETURNING id', [companyId,legacy])).rows[0].id;
    assert.ok(wwRun);

    // The restricted source never obtained any run or row during the test.
    assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs WHERE source_instance_id=$1', [obelisk])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM kristine.source_records WHERE source_instance_id=$1', [obelisk])).rows[0].n,0);
  } finally {
    await db.close();
  }
});
