'use strict';

/**
 * KRISTINE 2.0: isolated PostgreSQL READ model.
 * Fixed, parameterized SELECTs; no production connection, writes, imports,
 * payments, messages, payroll closes or access-control calls.
 */
const CUTOFF = '2026-10-01';
const TEST_DB_NAME = 'kristine_2_0_test_db';
const TEST_DB_USER = 'kristine_2_0_test_db_user';

function verifyTestDatabaseUrl(value) {
  if (typeof value !== 'string' || !value) throw new Error('Test database URL missing');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Invalid test database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname !== '/' + TEST_DB_NAME ||
      decodeURIComponent(url.username) !== TEST_DB_USER ||
      !url.password ||
      !/^dpg-[a-z0-9-]+(?:\.frankfurt-postgres\.render\.com)?$/.test(url.hostname)) {
    throw new Error('Only the explicitly allocated KRISTINE 2.0 test database is permitted');
  }
  return value;
}

function safeCount(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid SQL count');
  return number;
}

async function readSqlOverview(pool, { companyId = null } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required');
  const client = await pool.connect();
  let active = false, invalid = false;
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    active = true;
    const schema = (await client.query("SELECT to_regclass('kristine.projects')::text AS projects")).rows[0];
    if (!schema?.projects) {
      await client.query('COMMIT'); active = false;
      return { state:'schema_missing',source:'test_postgres',counts:null,projects:[],employees:[] };
    }

    const companies = (await client.query('SELECT id::text id, name FROM kristine.companies ORDER BY name,id LIMIT 3')).rows;
    if (!companies.length) {
      await client.query('COMMIT'); active = false;
      return { state:'empty_database',source:'test_postgres',counts:null,projects:[],employees:[] };
    }
    const selected = companyId
      ? companies.find(row => row.id === companyId)
      : companies.length === 1 ? companies[0] : null;
    if (!selected) {
      await client.query('COMMIT'); active = false;
      return { state:'company_selection_required',source:'test_postgres',counts:null,projects:[],employees:[] };
    }

    const countSql = [
      'SELECT',
      '  (SELECT count(*)::text FROM kristine.projects WHERE company_id=$1) AS projects,',
      '  (SELECT count(*)::text FROM kristine.employees WHERE company_id=$1) AS employees,',
      '  (SELECT count(*)::text FROM kristine.assignments WHERE company_id=$1) AS assignments,',
      "  (SELECT count(*)::text FROM kristine.time_events WHERE company_id=$1 AND work_date >= DATE '2026-10-01') AS time_events_since_cutoff,",
      '  (SELECT count(*)::text FROM kristine.documents WHERE company_id=$1) AS document_records,',
      "  (SELECT count(*)::text FROM kristine.import_runs WHERE company_id=$1 AND status='validated') AS validated_imports"
    ].join('\n');
    const totals = (await client.query(countSql,[selected.id])).rows[0];
    const projects = (await client.query(
      'SELECT project_number, name, status FROM kristine.projects WHERE company_id=$1 ORDER BY project_number DESC LIMIT 40',
      [selected.id])).rows;
    const employees = (await client.query([
      'SELECT e.display_name, e.active, COALESCE((',
      '  SELECT MIN(x.external_id) FROM kristine.employee_external_ids x',
      "  WHERE x.company_id=e.company_id AND x.employee_id=e.id AND x.namespace='finkzeit'",
      "), '') AS personal_number FROM kristine.employees e WHERE e.company_id=$1",
      'ORDER BY e.active DESC, e.display_name ASC LIMIT 40',
    ].join('\n'), [selected.id])).rows;
    const sourceRows = (await client.query([
      'SELECT si.system_code, count(*)::text AS runs',
      'FROM kristine.import_runs ir',
      'JOIN kristine.source_instances si ON si.id=ir.source_instance_id AND si.company_id=ir.company_id',
      "WHERE ir.company_id=$1 AND ir.status='validated' AND si.system_code <> 'obelisk'",
      'GROUP BY si.system_code ORDER BY si.system_code',
    ].join('\n'), [selected.id])).rows;

    const counts = {};
    for (const [key,value] of Object.entries(totals || {})) counts[key] = safeCount(value);
    const sources = sourceRows.map(row => ({
      system:String(row.system_code),validatedRuns:safeCount(row.runs)
    }));
    await client.query('COMMIT'); active = false;
    return {
      state:'ready',source:'test_postgres',
      company:{name:String(selected.name),id:String(selected.id)},
      counts,sources,
      projects:projects.map(row=>({
        number:String(row.project_number),name:String(row.name),status:row.status,
      })),
      employees:employees.map(row=>({
        name:String(row.display_name),active:row.active===true,
        personalNumber:String(row.personal_number || ''),
      })),
    };
  } catch(error) {
    invalid = true;
    if (active) { try { await client.query('ROLLBACK'); } catch {} }
    throw error;
  } finally {
    client.release(invalid);
  }
}

module.exports = {readSqlOverview,verifyTestDatabaseUrl,CUTOFF,TEST_DB_NAME,TEST_DB_USER};
