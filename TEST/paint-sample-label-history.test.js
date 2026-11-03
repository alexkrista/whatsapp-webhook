"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {registerPaintSampleLabelHistory} = require("../paint-sample-label-history");

function fakeApp() {
  const routes = {GET:new Map(),POST:new Map()};
  return {
    routes,
    get(url,handler){routes.GET.set(url,handler);},
    post(url,handler){routes.POST.set(url,handler);},
  };
}
async function call(app,method,url,{body={},query={},headers={"x-admin-token":"sample-label-test"}}={}) {
  const handler = app.routes[method].get(url);
  assert(handler,method+" "+url+" route registered");
  const res={
    statusCode:200,body:null,cache:"",status(n){this.statusCode=n;return this;},
    set(k,v){if(k==="Cache-Control")this.cache=v;return this;},
    json(b){this.body=b;return this;},
  };
  await handler({method,body,query,headers,path:url},res);
  return res;
}

(async()=>{
  const old=process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN="sample-label-test";
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"krista-sample-history-"));
  try {
    const app=fakeApp();
    registerPaintSampleLabelHistory(app,{dataDir:temp});
    const url="/admin/api/paint/sample-label-history";

    let result=await call(app,"GET",url);
    assert.equal(result.statusCode,200);
    assert.equal(result.body.count,0);
    assert.equal(result.cache,"no-store");

    const payload={
      id:"sample_20261103_firstprint",colour:"Slaked Lime 105",
      material:"Intelligent Matt",reference:"LG-65",
      printedAt:"1999-01-01T00:00:00Z", // Kein vom Client vorgegebenes Druckdatum.
      logo:"CUSTOM-NOT-ALLOWED",
    };
    for(const invalid of [
      {...payload,id:"bad"}, {...payload,colour:""},
      {...payload,colour:"bad ^XA"}, {...payload,material:"word".repeat(20)},
      {...payload,reference:"unbekannt\nHack"},
    ]) {
      result=await call(app,"POST",url,{body:invalid});
      assert.equal(result.statusCode,400,JSON.stringify(invalid));
    }
    result=await call(app,"GET",url);
    assert.equal(result.body.count,0,"Fehlversuche duerfen nicht protokolliert werden");

    result=await call(app,"POST",url,{body:payload});
    assert.equal(result.statusCode,200,JSON.stringify(result.body));
    assert.equal(result.body.existing,false);
    assert.equal(result.body.item.kind,"sample");
    assert.equal(result.body.item.colour,"Slaked Lime 105");
    assert.equal(result.body.item.material,"Intelligent Matt");
    assert.equal(result.body.item.reference,"LG-65");
    assert.equal(result.body.item.logo,undefined);
    assert.notEqual(result.body.item.printedAt,payload.printedAt);
    assert(Number.isFinite(Date.parse(result.body.item.printedAt)));

    const firstDate=result.body.item.printedAt;
    result=await call(app,"POST",url,{body:payload});
    assert.equal(result.statusCode,200);
    assert.equal(result.body.existing,true,"Bei Wiederholung kein zweiter Historieneintrag");
    assert.equal(result.body.item.printedAt,firstDate);
    result=await call(app,"POST",url,{body:{...payload,material:"Anderes Material"}});
    assert.equal(result.statusCode,409,"Druck-ID darf nicht mit anderen Daten ueberschrieben werden");

    result=await call(app,"POST",url,{body:{
      id:"sample_20261103_secondprint",colour:"Bronze Red 15",
      material:"Absolute Matt",reference:"",
    }});
    assert.equal(result.statusCode,200);
    const savedFile=path.join(temp,"_kristine","paint","sample-label-history.json");
    const saved=JSON.parse(await fs.readFile(savedFile,"utf8"));
    assert.equal(saved.length,2);
    assert.equal(saved[0].colour,"Bronze Red 15");
    assert.equal(saved[1].colour,"Slaked Lime 105");

    result=await call(app,"GET",url,{query:{q:"Slaked",limit:20}});
    assert.equal(result.body.count,1);
    assert.equal(result.body.items[0].reference,"LG-65");

    result=await call(app,"GET",url,{query:{limit:1,offset:1}});
    assert.equal(result.body.count,2);
    assert.equal(result.body.items.length,1);
    assert.equal(result.body.items[0].colour,"Slaked Lime 105");

    // Daten muessen einen Neustart/Deploy unveraendert ueberstehen.
    const restarted=fakeApp();
    registerPaintSampleLabelHistory(restarted,{dataDir:temp});
    result=await call(restarted,"GET",url);
    assert.equal(result.body.count,2);
    assert.equal((await call(restarted,"POST",url,{body:payload})).body.existing,true);

    // Nur authentifizierte Admins.
    result=await call(restarted,"GET",url,{headers:{}});
    assert.equal(result.statusCode,403);
    result=await call(restarted,"POST",url,{headers:{},body:payload});
    assert.equal(result.statusCode,403);

    // Beschaedigte Bestandsdatei niemals durch ein leeres Archiv ersetzen.
    await fs.writeFile(savedFile,'{bad json','utf8');
    result=await call(restarted,"POST",url,{body:{
      id:"sample_20261103_moreprint",colour:"Test",material:"Matt",
    }});
    assert.equal(result.statusCode,500);
    assert.equal(await fs.readFile(savedFile,"utf8"),'{bad json');

    console.log("Persistent shared Musteretiketten history, search, idempotence and auth ok");
  }finally{
    if(old===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=old;
    await fs.rm(temp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
