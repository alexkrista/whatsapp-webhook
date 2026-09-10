"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const {baseKey,sizeKey}=require("./paint-stock-ledger");
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
function reference(catalog){
 const products=new Map(catalog.products.map(p=>[String(p.productId),p]));
 const bases=new Map(catalog.basePaints.map(b=>[String(b.baseId),b]));
 const sizes=new Map(catalog.canSizes.map(s=>[String(s.canSizeId),s]));
 const byEan=new Map(),byKey=new Map();
 for(const c of catalog.cans){
  const b=bases.get(String(c.baseId)),p=products.get(String(b?.productId)),s=sizes.get(String(c.canSizeId));
  if(!b||!p||!s||!c.defaultBarcode)continue;
  const identity={ean:String(c.defaultBarcode),product:p.productName,productCode:p.productCode,base:b.baseCode,size:s.canSizeCode,legacy:/\bOLD\b/i.test(p.productName)};
  const k=[p.productCode,baseKey(b.baseCode),sizeKey(s.canSizeCode)].join("|");
  const prior=byEan.get(identity.ean);
  if(prior&&[prior.productCode,baseKey(prior.base),sizeKey(prior.size)].join("|")!==k)throw Error("Widersprüchliche EAN in Maschinendatenbank");
  if(!prior||prior.legacy&&!identity.legacy)byEan.set(identity.ean,identity);
  const old=byKey.get(k);if(old&&old.ean!==identity.ean)throw Error("Mehrere EANs für dieselbe Produktvariante");
  if(!old||old.legacy&&!identity.legacy)byKey.set(k,identity);
 }
 return {byEan,byKey};
}
function reconcile(rows,catalog){
 const {byEan,byKey}=reference(catalog);const changes=[];
 const oldEans=catalog.previousCatalog ? reference(catalog.previousCatalog).byEan : new Map();
 const result=rows.map(a=>{
  // Article identity and stock remain attached to their existing stock code.
  const code=String(a.stockCode||"").slice(0,4);
  const k=[code,baseKey(a.baseCode||a.baseName),sizeKey(a.size)].join("|");
  const match=byKey.get(k),knownWrong=byEan.has(String(a.ean||""))&&!match;
  if(!match&&!knownWrong)return a;
  const ean=match?.ean||"";
  if(ean===String(a.ean||""))return a;
  changes.push({id:a.id,product:a.product,base:a.baseName||a.baseCode,size:a.size,before:a.ean||"",after:ean,reason:match?"Maschinendatenbank":"EAN gehört zu anderer Produktvariante"});
  const aliases=(a.eanAliases||[]).filter(alias=>!byEan.has(String(alias)));
  const oldIdentity=oldEans.get(String(a.ean||""));
  if(a.ean&&!byEan.has(String(a.ean))&&oldIdentity&&[oldIdentity.productCode,baseKey(oldIdentity.base),sizeKey(oldIdentity.size)].join("|")===k)aliases.push(String(a.ean));
  return {...a,ean,eanAliases:[...new Set(aliases)],eanHistory:[...(a.eanHistory||[]),{at:new Date().toISOString(),before:a.ean||"",after:ean,source:"Innovatint 09/2026"}]};
 });
 return {rows:result,changes,referenceCount:byEan.size};
}
function registerPaintEanReconcile(app,options={}){
 const root=path.join(options.dataDir||process.env.DATA_DIR||"/var/data","_kristine","paint");
 const file=path.join(root,"articles.json"),catalogFile=path.join(root,"innovatint-catalog.json");
 const auth=(req,res)=>{const t=process.env.ADMIN_TOKEN;if(t&&String(req.headers["x-admin-token"]||req.query.token||"")!==t){res.status(403).json({ok:false,error:"Forbidden"});return false;}return true;};
 function plan(){const raw=fs.readFileSync(file,"utf8"),catalog=JSON.parse(fs.readFileSync(catalogFile,"utf8"));if(!catalog.previousCatalog)throw Error("Zuerst neuen Katalog mit Archiv aktivieren");return {raw,revision:hash(raw),...reconcile(JSON.parse(raw),catalog)};}
 app.get("/admin/api/paint/ean-reconcile",(req,res)=>{if(!auth(req,res))return;try{const p=plan();res.json({ok:true,revision:p.revision,changes:p.changes,referenceCount:p.referenceCount});}catch(e){res.status(400).json({ok:false,error:e.message});}});
 app.post("/admin/api/paint/ean-reconcile",(req,res)=>{
  if(!auth(req,res))return;
  try{
   const p=plan();if(req.body?.revision!==p.revision)return res.status(409).json({ok:false,error:"Stamm wurde geändert. Vergleich erneut laden."});
   if(p.changes.length){
    const backup=path.join(root,"ean-backups");fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,`${Date.now()}-${p.revision}.json`),p.raw,{flag:"wx"});
    const tmp=file+".ean.tmp";fs.writeFileSync(tmp,JSON.stringify(p.rows,null,2));fs.renameSync(tmp,file);
   }
   res.json({ok:true,changed:p.changes.length,changes:p.changes});
  }catch(e){res.status(400).json({ok:false,error:e.message});}
 });
}
module.exports={reference,reconcile,registerPaintEanReconcile};
