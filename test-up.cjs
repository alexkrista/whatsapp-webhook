const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {registerDayClose} = require('./day-close');
const {registerKristine} = require('./kristine');
(async () => {
  const root = await fs.mkdtemp(path.join(__dirname, 'test-data-'));
  const routes = new Map();
  const app = Object.fromEntries(['get','post','put','patch','delete'].map(method => [method, (url, fn) => routes.set(method+' '+url, fn)]));
  const employees = [{id:'test-worker',name:'Test'}];
  const config = {dataDir:root, requireAdmin:()=>true, readEmployees:async()=>employees, logger:{error:()=>{},log:()=>{}}};
  registerDayClose(app, config);
  const core = registerKristine(app, config);
  const date = core.localDateISO();
  async function call(method, url, body={}, params={}) {
    let code = 200, value;
    const res = {status(c){code=c;return this},json(v){value=v;return this}};
    await routes.get(method+' '+url)({body,params,query:{}},res);
    return {code,value};
  }
  const readEvents = async()=>JSON.parse(await fs.readFile(path.join(root,'_kristine','time-events.json'),'utf8'));
  try {
    await fs.mkdir(path.join(root,'26001'));
    await fs.writeFile(path.join(root,'26001','.meta.json'),JSON.stringify({name:'Testbaustelle',status:'Auftrag'}));
    let response = await call('get','/kristine/api/active-jobs');
    assert.equal(response.value.jobs.length,1);
    for(const code of ['913','917','901','902']) assert(response.value.upReasons.some(row=>row.upCode===code));
    assert.equal((await call('post','/kristine/api/switch-job',{employeeId:'test-worker',date,upCode:'bad'})).code,400);
    assert.equal((await call('post','/kristine/api/switch-job',{employeeId:'test-worker',date,upCode:'913',jobId:'26001'})).code,400);
    response = await call('post','/kristine/api/switch-job',{employeeId:'test-worker',date,upCode:'913'});
    assert.equal(response.code,200); assert.equal(response.value.continued,false);
    let reply = await core.handleMessage({employeeId:'test-worker',employeeName:'Test',text:'start',date});
    assert.equal(reply.state.mode,'working');
    assert.equal((await readEvents()).at(-1).type,'up');
    assert.equal((await readEvents()).at(-1).reason,'Werkstatt');
    await core.handleMessage({employeeId:'test-worker',employeeName:'Test',text:'pause',date});
    assert.equal((await readEvents()).at(-1).type,'pause');
    await core.handleMessage({employeeId:'test-worker',employeeName:'Test',text:'weiter',date});
    assert.equal((await readEvents()).at(-1).type,'up');
    response = await call('post','/kristine/api/switch-job',{employeeId:'test-worker',date,jobId:'26001'});
    assert.equal(response.value.continued,true);
    assert.equal((await readEvents()).at(-1).type,'weiter');
    for(const code of ['917','902','901']) {
      response = await call('post','/kristine/api/switch-job',{employeeId:'test-worker',date,upCode:code});
      assert.equal(response.value.continued,true);
      assert.equal((await readEvents()).at(-1).upCode,code);
    }
    const count = (await readEvents()).length;
    await call('post','/kristine/api/switch-job',{employeeId:'test-worker',date,upCode:'901'});
    assert.equal((await readEvents()).length,count);
    response = await call('get','/kristine/api/segments/:employeeId/:date',{}, {employeeId:'test-worker',date});
    assert.equal(response.code,200);
    assert(response.value.segments.some(row=>row.type==='up' && row.reason==='Arzt'));
    console.log('PASS: catalog, invalid/ambiguous selection, UP start, pause/resume, site switch, four UP reasons, duplicate selection, office segments');
  } finally {
    if(path.dirname(path.resolve(root))!==path.resolve(__dirname)) throw new Error('Unsafe cleanup path');
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
