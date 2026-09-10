"use strict";
const assert=require("assert"),fsp=require("fs/promises"),os=require("os"),path=require("path"),Module=require("module");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function harness(){const routes=new Map(),app={};for(const method of ["get","post","put","patch","delete"])app[method]=(route,handler)=>routes.set(`${method.toUpperCase()} ${route}`,handler);return{app,routes}}
function response(){return{statusCode:200,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}}}
async function invoke(handler,{params={},body={}}={}){const res=response();await handler({params,body,query:{}},res);return res}
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"released-time-separation-")),root=path.join(temp,"_kristine");await fsp.mkdir(root,{recursive:true});
  await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify([
    {employeeId:"139",employeeName:"Clemens",date:"2026-09-08",type:"start",at:"07:00",jobId:"26080",jobName:"Fink_Loos"},
    {employeeId:"139",employeeName:"Clemens",date:"2026-09-08",type:"ende",at:"16:00",jobId:"26080",jobName:"Fink_Loos"}
  ]));
  const {app,routes}=harness();registerKristine(app,{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[{id:"139",name:"Clemens",personnelNumber:"139"}]});
  try{
    let res=await invoke(routes.get("PUT /kristine/api/day-release/:employeeId/:date"),{params:{employeeId:"139",date:"2026-09-08"},body:{employeeName:"Clemens",reviewer:"Bettina",checks:{times:true,regie:true,close:true,diet:true,fl:true,ch:true}}});
    assert.equal(res.statusCode,200);
    let archive=JSON.parse(await fsp.readFile(path.join(root,"project-time-archive.json"),"utf8"));
    assert.equal(archive[0].segments[0].jobId,"26080");
    let personal=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert(personal.every(row=>!row.jobId&&row.detachedFromProject===true));
    const releasedSegments=await invoke(routes.get("GET /kristine/api/segments/:employeeId/:date"),{params:{employeeId:"139",date:"2026-09-08"}});
    assert.equal(releasedSegments.body.released,true);assert(releasedSegments.body.segments.every(row=>!row.jobId));
    let bootstrap=await invoke(routes.get("GET /kristine/api/bootstrap"));
    assert.equal(bootstrap.body.projectTimeArchive[0].segments[0].jobId,"26080");
    res=await invoke(routes.get("PUT /kristine/api/segments/:employeeId/:date"),{params:{employeeId:"139",date:"2026-09-08"},body:{employeeName:"Clemens",reason:"Korrektur",correctedBy:"Bettina",segments:[{id:"x",type:"up",from:"08:00",to:"14:00",jobId:"99999",jobName:"Andere Baustelle",reason:"Krank"}]}});
    assert.equal(res.statusCode,200);
    archive=JSON.parse(await fsp.readFile(path.join(root,"project-time-archive.json"),"utf8"));
    assert.equal(archive.length,1);assert.equal(archive[0].segments[0].jobId,"26080");assert.equal(archive[0].segments[0].from,"07:00");
    personal=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert.equal(personal[0].at,"08:00");assert.equal(personal[0].jobId,null);assert.equal(personal[0].activityMode,"unproductive");assert.equal(personal[0].unproductiveCategory,"sick");assert.equal(personal[0].unproductiveCode,"901");
    res=await invoke(routes.get("PUT /kristine/api/segments/:employeeId/:date"),{params:{employeeId:"139",date:"2026-09-08"},body:{employeeName:"Clemens",reason:"Korrektur",correctedBy:"Bettina",segments:[{id:"y",type:"up",from:"08:00",to:"14:00",reason:"Werkstatt"}]}});
    assert.equal(res.statusCode,200);
    personal=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert.equal(personal[0].type,"start");assert.equal(personal[0].activityMode,"productive");assert(!personal[0].unproductiveCategory);
    console.log("OK: Freigabe trennt unveränderliche Baustellenstunden von der persönlichen Zeitkarte");
  }finally{await fsp.rm(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
