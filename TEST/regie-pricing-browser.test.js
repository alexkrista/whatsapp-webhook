const fs=require('fs'),path=require('path'),assert=require('assert');
const {launchTestBrowser}=require('./browser-runtime');
(async()=>{const browser=await launchTestBrowser({headless:true});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=fs.readFileSync(path.join(__dirname,'../public/regie-workbench.html'),'utf8').replace("loadBase().catch(error=>{$('queue').innerHTML=`<div class=\"empty\">${error.message}</div>`});",'');
 await page.route('http://regie.test/**',route=>route.fulfill({contentType:route.request().url().includes('.js')?'text/javascript':'text/html; charset=utf-8',body:route.request().url().includes('.js')?'':html}));
 await page.addInitScript(()=>{window.createKristaTopbar=()=>{}});
 await page.goto('http://regie.test/');
 await page.evaluate(async()=>{
  window.saved={id:'r1',jobId:'26082',date:'2026-09-11',reportSequence:19,status:'completed',processingStatus:'archived',description:'Gewebe',hourlyRate:75,materialMarkup:50,employees:[{id:'1',name:'Clemens',from:'07:00',to:'11:53',hours:5}],materials:[{materialId:'m1',product:'Kleber',unit:'Sack',containerSize:20,quantity:2,purchasePrice:22.17,salePrice:33.26,markup:50}],attachments:[{id:'foto-1',name:'Originalfoto.jpg',type:'image/jpeg'}]};
  jobs=[{jobId:'26082',name:'Test'}];allEmployees=[{id:'1',name:'Clemens'}];materials=[{...saved.materials[0]}];
  window.writes=[];api=async(url,options)=>{if(url.endsWith('/save')){const body=JSON.parse(options.body);writes.push(body);saved={...saved,...body};return {report:saved}}if(url==='/admin/api/materials')return {materials:[{...materials[0],unit:'kg'}]};return {reports:[saved],suggestions:[],recipients:[]}};
  await openReport(saved);
 });
 await page.locator('.emp-discount').fill('50');
 assert.equal((await page.locator('.emp-total').innerText()).replace(/\s/g,' '),'€ 187,50');
 await page.locator('.emp-discount').fill('100');
 assert.equal((await page.locator('.emp-total').innerText()).replace(/\s/g,' '),'€ 0,00');
 await page.locator('.mat-markup').fill('20');
 assert.equal(await page.locator('.mat-vk').inputValue(),'26,6');
 await page.locator('#saveDraft').click();await page.waitForFunction(()=>writes.length===1&&!savingReport);
 assert.equal(await page.evaluate(()=>saved.employees[0].discountPercent),100);
 assert.equal(await page.evaluate(()=>saved.materials[0].markupOverride),true);
 await page.locator('#closeEditor').click();await page.evaluate(()=>openReport(saved));
 assert.equal(await page.locator('.emp-discount').inputValue(),'100');
 assert.equal(await page.locator('.mat-markup').inputValue(),'20');
 assert.deepEqual(errors,[]);console.log('OK: 50/100 customer discount and per-material markup edit, save and reopen.');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
