'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importProjects}=require('../storage/import-project-metadata');
const {importContactGroups}=require('../storage/import-contact-groups');
const {importProjectAddresses}=require('../storage/import-project-addresses');
const {reconcileMasterData}=require('../storage/reconcile-master-data');
test('master reconciliation retains original names and addresses, latest contact links, removals and rollback',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id;
  const scope={companyId,sourceInstanceId};const contact={id:'C',displayName:'Person',roles:['siteManager'],firstName:'Alex',lastName:'Test',email:'first@example.test',phone:'001234'};
  const raw={jobId:'001',name:'Original',status:2,street:'Old',houseNumber:'01a',postalCode:'0012',city:'City',projectContacts:{siteManager:{masterContactId:'C',inline:'retained'}}};
  const records=a=>a.map(p=>({externalId:p.jobId,originalText:JSON.stringify(p)}));
  await importProjects(pool,{...scope,records:records([raw])});await importContactGroups(pool,{...scope,originalText:JSON.stringify([contact])});await importProjectAddresses(pool,scope);
  const run=(contacts,projects)=>reconcileMasterData(pool,{...scope,contactsText:JSON.stringify(contacts),projects:records(projects)});
  const first=await run([contact],[raw]);assert.equal(first.contactVersionsCreated,1);assert.equal(first.projectVersionsCreated,1);assert.equal(first.linksVerified,1);
  const replay=await run([contact],[raw]);assert.equal(replay.contactVersionsCreated,0);assert.equal(replay.projectVersionsCreated,0);
  const changedContact={...contact,email:'second@example.test'};
  const changedRaw={...raw,name:'Updated',street:'New'};
  await run([changedContact],[changedRaw]);assert.equal((await db.query('SELECT email FROM kristine.latest_imported_contacts')).rows[0].email,'second@example.test');
  const latest=(await db.query('SELECT name,street,house_number,postal_code FROM kristine.latest_imported_projects')).rows[0];assert.deepEqual(latest,{name:'Updated',street:'New',house_number:'01a',postal_code:'0012'});
  assert.equal((await db.query('SELECT name FROM kristine.projects')).rows[0].name,'Original');assert.equal((await db.query('SELECT street FROM kristine.addresses')).rows[0].street,'Old');
  const revertedContact=await run([contact],[changedRaw]);assert.equal(revertedContact.projectVersionsCreated,0);assert.equal(revertedContact.contactVersionsCreated,0);
  const linked=(await db.query('SELECT c.email FROM kristine.latest_imported_projects p JOIN kristine.master_reconciliation_project_contacts l ON l.import_run_id=p.reconciliation_run_id AND l.project_version_id=p.id JOIN kristine.imported_contact_versions c ON c.id=l.contact_version_id')).rows[0];assert.equal(linked.email,'first@example.test');
  const missing=await run([],[changedRaw]);assert.equal(missing.unresolvedContactLinks,1);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_contacts')).rows[0].n,0);
  const n=(await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n;
  await assert.rejects(run([changedContact],[{...changedRaw,projectContacts:{owner:'invalid'}}]),/role reference/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,n);
  await assert.rejects(reconcileMasterData(pool,{companyId:'00000000-0000-0000-0000-000000000001',sourceInstanceId,contactsText:'[]',projects:[]}),/mismatch/);
  await run([],[]);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_projects')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.imported_project_versions')).rows[0].n,2);
  for(const t of ['imported_contact_versions','imported_project_versions','master_reconciliation_project_contacts'])await assert.rejects(db.query('DELETE FROM kristine.'+t),/append-only/);
 }finally{await db.close();}
});
