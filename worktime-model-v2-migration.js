"use strict";

const fs=require("fs");
const path=require("path");
const DATA_DIR=process.env.DATA_DIR||"/var/data";
const FILE=path.join(DATA_DIR,"_system","worktime-models.json");
const clone=value=>JSON.parse(JSON.stringify(value));
const alexTarget={id:"alex-soll-mo-fr",days:[1,2,3,4,5],from:"07:00",to:"13:48",lunchFrom:"",lunchTo:"",pauseFrom:"",pauseTo:"",activityCode:"",activityLabel:""};
const alexFixed={...alexTarget,id:"alex-fink-mo-fr",activityCode:"SITE_LT120",activityLabel:"Baustelle < 120 km"};

function ensureBlock(model,key,label){
  model.timeModelVersion=2;
  model.blocks=model.blocks&&typeof model.blocks==="object"?model.blocks:{};
  model.blocks[key]=model.blocks[key]&&typeof model.blocks[key]==="object"?model.blocks[key]:{label,rows:[]};
  model.blocks[key].label=label;
  model.blocks[key].rows=Array.isArray(model.blocks[key].rows)?model.blocks[key].rows:[];
  return model.blocks[key];
}
function patch(){
  if(!fs.existsSync(FILE))return false;
  let models;try{const parsed=JSON.parse(fs.readFileSync(FILE,"utf8"));models=Array.isArray(parsed)?parsed:[]}catch{return false}
  let changed=false;
  const prod=models.find(m=>String(m?.id)==="krista-standard");
  if(prod&&["KRISTA-Modell","Produktion · Sommer/Winter","Krista Standard"].includes(String(prod.name||""))){prod.name="Produktive MA";changed=true}
  for(const model of models){
    ensureBlock(model,"planning","Planungsstunden");
    ensureBlock(model,"finkTarget","Sollstunden Finkzeit");
    ensureBlock(model,"finkFixed","Finkzeit-Ausgabe fix");
    if(["office-geri","office-judith","office-alex"].includes(String(model.id))&&model.blocks.finkFixed.enabled!==true){model.blocks.finkFixed.enabled=true;changed=true}
    if(String(model.id)==="office-alex"){
      if(!model.blocks.finkTarget.rows.length){model.blocks.finkTarget.rows=[clone(alexTarget)];changed=true}
      if(!model.blocks.finkFixed.rows.length){model.blocks.finkFixed.rows=[clone(alexFixed)];changed=true}
      for(const row of model.blocks.finkFixed.rows){
        const oldCode=String(row?.activityCode||"").trim();
        const oldLabel=String(row?.activityLabel||"").trim();
        const isOldOffice=oldCode==="022"||/^(büro|buero)$/i.test(oldLabel);
        const isEmptyAlexDefault=String(row?.id||"")==="alex-fink-mo-fr"&&!oldCode&&!oldLabel;
        if(isOldOffice||isEmptyAlexDefault){
          if(row.activityCode!=="SITE_LT120"){row.activityCode="SITE_LT120";changed=true}
          if(row.activityLabel!=="Baustelle < 120 km"){row.activityLabel="Baustelle < 120 km";changed=true}
        }
      }
      if(model.automaticTime!==true){model.automaticTime=true;changed=true}
      if(Number(model.automaticPayrollHours)!==6.8){model.automaticPayrollHours=6.8;changed=true}
      const oldReason=String(model.payrollReason||"").trim();
      if(!oldReason||/^(büro|buero)$/i.test(oldReason)){model.payrollReason="Baustelle < 120 km";changed=true}
      if(model.projectTimeSource!=="actual_stamps"){model.projectTimeSource="actual_stamps";changed=true}
    }
  }
  if(changed){fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(models,null,2),"utf8")}
  return true;
}
if(!patch())for(const delay of [1000,5000,15000,45000]){const t=setTimeout(patch,delay);t.unref?.()}
