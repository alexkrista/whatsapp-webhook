// Run with Playwright available through NODE_PATH. Uses only synthetic invoices and mocked APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'brain_material_selection.py'), 'utf8');
const ui = source.split("UI = r'''\n")[1].split("\n'''")[0];
const archive = fs.readFileSync(path.join(root, 'archive-connector.py'), 'utf8');
const viewer = "function urlFor(route,path){return route+'?path='+encodeURIComponent(path)}\n" + archive.slice(archive.indexOf("let pdfState={"), archive.indexOf("document.addEventListener('click',e=>{const a=e.target.closest('a.action"));
const html = `<!doctype html><html><body><div id="materialResults"><div class="material-global-card"><div class="material-hit-line">1 SKU-17 Farbe 2 Stk 12,50 25,00</div><a href="/pdf?path=invoice.pdf">Rechnung öffnen</a></div></div><div id="incomingGrouped"></div>
<div id="pdfSuperModal" hidden><div id="pdfSuperTitle"></div><div class="pdf-super-tools">${['Prev','Next','Minus','Plus','100','Width','LoupeToggle','Close'].map(id=>`<button id="pdf${id}">${id}</button>`).join('')}<a id="pdfOriginal">Original</a></div><div id="pdfStatus"></div><div id="pdfStage" style="position:relative;width:900px;height:600px;overflow:auto"><img id="pdfImage" style="width:600px;height:400px"></div><div id="pdfLoupe"></div></div><script>${viewer}</script>${ui}</body></html>`;

(async () => {
 const browser = await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL || 'chrome', headless:true});
 try {
  const page = await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const requests=[];
  await page.route('http://brain.test/**', async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
   if(url.pathname==='/pdf-page')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="white"/></svg>'});
   let data={ok:true};
   if(url.pathname==='/pdf-info')data={ok:true,pages:2,width:600};
   if(url.pathname.endsWith('/text'))data={ok:true,width:600,height:400,words:[{text:'Farbe',x0:20,y0:20,x1:70,y1:40},{text:'12,50',x0:80,y0:20,x1:125,y1:40}]};
   if(url.pathname.endsWith('/preview')){
    const body=route.request().postDataJSON();requests.push(body);
    data={ok:true,token:'test-token',recognized:true,source:{...body,invoiceNumber:'R17',invoiceDate:'2026-09-11'},fields:{product:'Farbe <img src=x onerror=alert(1)>',supplier:'Lieferant',supplierArticleNumber:'SKU-17',unit:'Stk',containerSize:1,purchasePrice:12.5}};
   }
   if(url.pathname.endsWith('/save')){requests.push(route.request().postDataJSON());data={ok:true,created:true,material:{product:'Geprüfte Farbe'}};}
   return route.fulfill({json:data});
  });
  await page.goto('http://brain.test/');
  assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'＋ Material anlegen',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('brainMaterialSave').disabled);
  assert.equal(requests[0].path,'invoice.pdf');
  assert.equal(requests[0].selection,'1 SKU-17 Farbe 2 Stk 12,50 25,00');
  assert.equal(await page.locator('#brainMaterialDialog img').count(),0);
  await page.getByLabel('Materialname',{exact:true}).fill('Geprüfte Farbe');
  await page.getByRole('button',{name:'Im Materialstamm speichern',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('brainMaterialMessage').textContent.includes('✓ Material gespeichert'));
  assert.equal(requests[1].fields.product,'Geprüfte Farbe');
  await page.getByRole('button',{name:'Schließen',exact:true}).click();
  await page.evaluate(()=>openBrainPdf('invoice.pdf','Rechnung'));
  await page.waitForSelector('#brainSelectionLayer span');
  await page.evaluate(()=>{const spans=document.querySelectorAll('#brainSelectionLayer span'),r=document.createRange();r.setStart(spans[0].firstChild,0);r.setEnd(spans[1].firstChild,5);const s=window.getSelection();s.removeAllRanges();s.addRange(r)});
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='＋ Material aus Auswahl').disabled);
  await page.getByRole('button',{name:'＋ Material aus Auswahl',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('brainMaterialSave').disabled);
  assert.equal(requests[2].selection,'Farbe 12,50');assert.equal(requests[2].page,1);
  await page.getByRole('button',{name:'Schließen',exact:true}).click();
  await page.locator('#pdfNext').click();
  assert.equal(await page.getByRole('button',{name:'＋ Material aus Auswahl',exact:true}).isDisabled(),true);
  await page.evaluate(()=>openBrainPdf('other.pdf','Andere Rechnung'));
  assert.equal(await page.getByRole('button',{name:'Auswahl kopieren',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log('Browser: search line, review/edit/save, safe text, PDF selection, page/document reset passed.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
