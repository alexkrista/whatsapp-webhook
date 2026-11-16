"use strict";
const fs=require("fs/promises"),path=require("path"),crypto=require("crypto");
exports.registerCompanyDocuments=function(app,{dataDir,requireAdmin,sendMail}){
 const root=path.join(dataDir,"_kristine","company-documents");
 const guard=fn=>async(req,res)=>{if(!requireAdmin(req,res))return;res.set("Cache-Control","no-store");try{await fs.mkdir(root,{recursive:true});await fn(req,res)}catch(e){console.error("company-documents",e.message);res.status(500).json({ok:false,error:"Vorgang fehlgeschlagen. Bitte erneut versuchen."})}};
 const valid=id=>/^[a-f0-9-]{36}$/.test(String(id));
 const read=async id=>{if(!valid(id))return null;try{return JSON.parse(await fs.readFile(path.join(root,id+".json"),"utf8"))}catch(e){if(e.code==="ENOENT")return null;throw e}};
 app.get("/admin/company-documents",guard(async(req,res)=>res.sendFile(path.join(__dirname,"public","company-documents.html"))));
 app.get("/admin/api/company-documents",guard(async(req,res)=>{
 const names=(await fs.readdir(root)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));
 const documents=await Promise.all(names.map(n=>read(n.slice(0,-5))));
 res.json({ok:true,documents:documents.filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
 }));
 app.post("/admin/api/company-documents",guard(async(req,res)=>{
 const b=req.body||{},company=String(b.company||"").trim().slice(0,180),kind=String(b.kind||""),date=String(b.date||"");
 if(!company||!["Gewerbenachweis","Firmenbuchauszug","Sonstiges"].includes(kind)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))return res.status(400).json({ok:false,error:"Firma, Dokumentart und gültiges Ausstellungsdatum angeben."});
 const encoded=String(b.base64||"");if(encoded.length>15*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))return res.status(400).json({ok:false,error:"PDF ist ungültig oder zu groß (max. 10 MB)."});
 const bytes=Buffer.from(encoded,"base64");if(bytes.length>10*1024*1024||bytes.subarray(0,5).toString()!=="%PDF-")return res.status(400).json({ok:false,error:"Bitte eine PDF-Datei bis 10 MB auswählen."});
 const id=crypto.randomUUID(),filename=String(b.filename||"Dokument.pdf").replace(/[^\p{L}\p{N}._ -]/gu,"_").slice(0,160);
 const doc={id,company,kind,date,filename,createdAt:new Date().toISOString()};
 await fs.writeFile(path.join(root,id+".pdf"),bytes,{flag:"wx"});await fs.writeFile(path.join(root,id+".json"),JSON.stringify(doc),{flag:"wx"});
 res.status(201).json({ok:true,document:doc});
 }));
 app.get("/admin/api/company-documents/:id/pdf",guard(async(req,res)=>{
 const d=await read(req.params.id);if(!d)return res.status(404).json({ok:false,error:"Dokument nicht gefunden."});res.set("Content-Type","application/pdf");res.sendFile(path.join(root,d.id+".pdf"));
 }));
 app.post("/admin/api/company-documents/send",guard(async(req,res)=>{
 const b=req.body||{},to=String(b.to||"").trim();if(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to))return res.status(400).json({ok:false,error:"Gültige Empfängeradresse eingeben."});
 const ids=[...new Set(Array.isArray(b.ids)?b.ids:[])];if(!ids.length||ids.length>15)return res.status(400).json({ok:false,error:"1 bis 15 Dokumente auswählen."});
 const docs=await Promise.all(ids.map(read));if(docs.some(d=>!d))return res.status(400).json({ok:false,error:"Dokument nicht gefunden."});
 const sizes=await Promise.all(docs.map(d=>fs.stat(path.join(root,d.id+".pdf"))));if(sizes.reduce((n,s)=>n+s.size,0)>18*1024*1024)return res.status(400).json({ok:false,error:"Anhänge zusammen zu groß (max. 18 MB)."});
 await sendMail({to,subject:String(b.subject||"Firmenunterlagen Farben Krista").replace(/[\r\n]/g," ").slice(0,200),text:String(b.text||"Anbei die gewünschten Firmenunterlagen.").slice(0,10000),attachments:docs.map(d=>({filename:d.filename,path:path.join(root,d.id+".pdf"),contentType:"application/pdf"}))});
 res.json({ok:true});
 }));
};
