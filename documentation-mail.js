"use strict";
const fs=require("node:fs/promises"),path=require("node:path");
const {parseMsg,htmlToText}=require("./kristine-msg-reader");
const fail=(status,message)=>Object.assign(new Error(message),{status});
const senderEmail=row=>String(row?.fromEmail||row?.from||"").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()||"";

function emlText(buffer){
  function part(raw,depth=0){
    if(depth>15)return "";
    const split=raw.search(/\r?\n\r?\n/);if(split<0)return "";
    const headers=raw.slice(0,split).replace(/\r?\n[ \t]+/g," "),body=raw.slice(split).replace(/^\r?\n\r?\n/,"");
    const header=name=>headers.match(new RegExp(`^${name}:\\s*([^\\r\\n]*)`,"im"))?.[1]||"";
    const type=header("Content-Type")||"text/plain",disposition=header("Content-Disposition");
    if(/attachment|filename\*?=/i.test(disposition)||/\bname\*?=/i.test(type))return "";
    if(/^multipart\//i.test(type)){
      const boundary=type.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i),value=boundary?.[1]||boundary?.[2];if(!value)return "";
      const parts=body.split("--"+value).slice(1).filter(value=>!value.startsWith("--")).map(value=>value.replace(/^\r?\n/,""));
      if(/^multipart\/alternative/i.test(type)){
        const plain=parts.find(value=>/^Content-Type:\s*text\/plain\b/im.test(value));
        return (plain&&part(plain,depth+1))||parts.map(value=>part(value,depth+1)).find(Boolean)||"";
      }
      return parts.map(value=>part(value,depth+1)).filter(Boolean).join("\n\n");
    }
    if(!/^text\/(plain|html)\b/i.test(type))return "";
    const encoding=header("Content-Transfer-Encoding").toLowerCase();let bytes;
    if(encoding.includes("base64"))bytes=Buffer.from(body.replace(/\s/g,""),"base64");
    else if(encoding.includes("quoted-printable"))bytes=Buffer.from(body.replace(/=\r?\n/g,"").replace(/=([0-9a-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),"latin1");
    else bytes=Buffer.from(body,"latin1");
    const charset=type.match(/charset=["']?([^;\s"']+)/i)?.[1]||"utf-8";let text;
    try{text=new TextDecoder(charset).decode(bytes)}catch{text=bytes.toString("utf8")}
    return (/^text\/html/i.test(type)?htmlToText(text):text).replace(/\r\n/g,"\n").replace(/\u0000/g,"").trim();
  }
  return part(buffer.toString("latin1"));
}

const contactEmail=(meta,role)=>role==="owner"?meta.projectContacts?.owner?.womanEmail||meta.projectContacts?.owner?.email||meta.contactEmail||meta.customerMaster?.email||"":role==="ownerMan"?meta.projectContacts?.owner?.manEmail||"":meta.projectContacts?.[role]?.email||"";

function registerDocumentationMail(app,{requireAdmin,isSafeJobId,readDocumentation,documentationDir,readJobMeta,writeJobMeta,appendJobHistory}){
  const find=async req=>{
    const jobId=String(req.params.jobId||"");if(!isSafeJobId(jobId))throw fail(400,"Ungültige Baustelle.");
    const row=(await readDocumentation(jobId)).find(row=>row.type==="mail"&&row.id===req.params.mailId);
    if(!row)throw fail(404,"E-Mail nicht gefunden.");return {jobId,row};
  };
  app.get("/admin/api/job/:jobId/documentation/mail/:mailId",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const {jobId,row}=await find(req),name=String(row.storedName||"");
      if(!name||path.basename(name)!==name||!/^\.(msg|eml)$/i.test(path.extname(name)))throw fail(404,"Originalmail nicht gefunden.");
      const buffer=await fs.readFile(path.join(documentationDir(jobId),name)),body=path.extname(name).toLowerCase()===".msg"?parseMsg(buffer).mail.body:emlText(buffer);
      res.set("Cache-Control","no-store").json({ok:true,body:body.slice(0,500000),truncated:body.length>500000,fromEmail:senderEmail(row)});
    }catch(error){res.status(error.code==="ENOENT"?404:error.status||500).json({ok:false,error:error.code==="ENOENT"?"Originalmail nicht gefunden.":error.message})}
  });
  const queues=new Map();
  app.post("/admin/api/job/:jobId/documentation/mail/:mailId/contact",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const {jobId,row}=await find(req),role=String(req.body?.role||""),email=senderEmail(row);
      if(!["owner","ownerMan","siteManager","architect"].includes(role)||req.body?.confirmed!==true||!email)throw fail(400,"Bitte Absenderadresse und Empfängerzuordnung bestätigen.");
      const pending=(queues.get(jobId)||Promise.resolve()).catch(()=>{}).then(async()=>{
        const meta=await readJobMeta(jobId),before=contactEmail(meta,role);
        if(before.toLowerCase()===email)return {alreadyStored:true,meta};
        if(before!==String(req.body.expectedEmail||""))throw fail(409,"Die Kontaktadresse wurde inzwischen geändert. Bitte die Akte neu laden.");
        const projectContacts=structuredClone(meta.projectContacts||{}),patch={projectContacts};
        if(role==="owner"){
          projectContacts.owner={...projectContacts.owner,email,womanEmail:email};
          patch.contactEmail=email;patch.customerMaster={...meta.customerMaster,email};
        }else if(role==="ownerMan")projectContacts.owner={...projectContacts.owner,manEmail:email};
        else projectContacts[role]={...projectContacts[role],email};
        await writeJobMeta(jobId,patch);
        await appendJobHistory(jobId,{type:"mail_contact_saved",title:"E-Mail-Adresse aus importierter Mail übernommen",detail:email,source:"Dokumentation",data:{mailId:row.id,role,previousEmail:before}});
        return {alreadyStored:false,meta:await readJobMeta(jobId)};
      });
      queues.set(jobId,pending);
      try{res.json({ok:true,...await pending})}finally{if(queues.get(jobId)===pending)queues.delete(jobId)}
    }catch(error){res.status(error.status||500).json({ok:false,error:error.message})}
  });
}
module.exports={emlText,senderEmail,contactEmail,registerDocumentationMail};
