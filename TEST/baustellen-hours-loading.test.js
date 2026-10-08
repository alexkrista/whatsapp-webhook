"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const D=require('../public/ui/baustellen-data');
function browser(fetch){
  const events=[];
  const window={BaustellenData:D,addEventListener(){},dispatchEvent(e){events.push(e.type)}};
  const document={readyState:'loading',addEventListener(){},getElementById(){return null},querySelector(){return null},querySelectorAll(){return []}};
  const context={window,document,fetch,location:{search:'',hash:'',pathname:'/kristine/baustellen',origin:'https://example.test'},URL,URLSearchParams,Intl,Date,Map,Set,console:{warn(){}},queueMicrotask,setTimeout,clearTimeout,CustomEvent:class{constructor(type){this.type=type}}};
  for(const file of ['baustellen-hours-core.js','baustellen-live-hours.js'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/ui',file),'utf8'),context);
  return {api:window.BaustellenLiveHours,events};
}
test('all public hours summaries are safe before bootstrap and after a failed refresh',async()=>{
  const {api}=browser(async()=>{throw new Error('offline')});
  for(let attempt=0;attempt<2;attempt++){
    for(const method of ['summary','summarySingle']){
      const value=api[method]('26025','26025');
      assert.equal(value.total,0,method);
      assert.equal(value.complete,false,method);
    }
    assert.equal(api.completedSummarySingle('26025'),null);
    assert.equal(api.summarySingle('26025').available,false);
    assert.equal(api.sourceStatus('26025').label,'Stunden werden geladen');
    await api.refresh();
  }
});
test('pending bootstrap reports loading, then returns the loaded hours without a reload',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve});
  const {api,events}=browser(async raw=>{
    await pending;
    const data=String(raw).startsWith('/admin/api/jobs')?{jobs:[{jobId:'26025',status:'Auftrag',calculation:{actualHours:9.3,calculatedHours:20}}]}:{};
    return {ok:true,text:async()=>JSON.stringify(data)};
  });
  const refresh=api.refresh();
  assert.equal(api.summarySingle('26025').complete,false);
  release();await refresh;
  assert.equal(api.summarySingle('26025').total,9.3);
  assert.equal(api.summary('26025').total,9.3);
  assert.ok(events.includes('krista:live-hours-updated'));
});
