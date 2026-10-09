'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {archiveInvoice,listInvoiceDocuments}=require('../issued-invoice-project-archive');
const body=Buffer.from('%PDF-1.4\nLocal test invoice original\n%%EOF\n');
const digest=crypto.createHash('sha256').update(body).digest('hex');
const invoice={project:'24138',number:'202610003',invoiceId:'95',source:'KRISTINE',kind:'SR',date:'2026-10-07',digest};

test('correct issued invoice PDF appears in the correct project file, idempotently',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'krista-invoice-file-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'24138'));
  await fs.mkdir(path.join(dir,'24139'));
  const results=await Promise.all(Array.from({length:7},()=>archiveInvoice(dir,invoice,body)));
  assert.equal(results.filter(x=>x.created).length,1);
  assert.deepEqual((await listInvoiceDocuments(dir,'24138')).map(x=>({id:x.id,number:x.invoiceNumber,name:x.name})),
    [{id:'issued-invoice-KRISTINE-95',number:'202610003',name:'Schlussrechnung 202610003.pdf'}]);
  assert.deepEqual(await listInvoiceDocuments(dir,'24139'),[]);
  const original=await fs.readFile(path.join(dir,'24138','_documentation','invoice-KRISTINE-202610003-95.pdf'));
  assert.deepEqual(original,body);
  const names=await fs.readdir(path.join(dir,'24138','_documentation'));
  assert.equal(names.filter(x=>x.endsWith('.pdf')).length,1);
  assert.ok(names.every(x=>!x.includes('.tmp-')));
});

test('no rewriting PDF for a conflicting invoice number or checksum',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'krista-invoice-conflict-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'24138'));
  await archiveInvoice(dir,invoice,body);
  const altered=Buffer.from('%PDF-1.4\nA different invoice\n%%EOF\n');
  const changed={...invoice,digest:crypto.createHash('sha256').update(altered).digest('hex')};
  await assert.rejects(archiveInvoice(dir,changed,altered),/Abweichend/);
  await assert.rejects(archiveInvoice(dir,invoice,altered),/Prüfsumme/);
  assert.deepEqual(await fs.readFile(path.join(dir,'24138','_documentation','invoice-KRISTINE-202610003-95.pdf')),body);
});

test('never create a fake project or accept an invalid PDF',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'krista-invoice-safe-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await assert.rejects(archiveInvoice(dir,invoice,body),/nicht angelegt/);
  await fs.mkdir(path.join(dir,'24138'));
  for(const invalid of [{...invoice,project:'../24139'}, {...invoice,number:'../../bad'}, {...invoice,source:'OTHER'}]){
    await assert.rejects(archiveInvoice(dir,invalid,body),/Ungültig/);
  }
  await assert.rejects(archiveInvoice(dir,invoice,Buffer.from('not a PDF')),/Rechnungs-PDF/);
});
