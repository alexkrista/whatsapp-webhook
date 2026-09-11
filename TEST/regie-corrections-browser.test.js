const fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=fs.readFileSync(path.join(__dirname,'../public/regie-workbench.html'),'utf8').replace("loadBase().catch(error=>{$('queue').innerHTML=`<div class=\"empty\">${error.message}</div>`});",'');
 await page.route('http://regie.test/**',route=>route.fulfill({contentType:route.request().url().includes('.js')?'text/javascript':'text/html; charset=utf-8',body:route.request().url().includes('.js')?'':html}));
 await page.addInitScript(()=>{window.createKristaTopbar=()=>{}});
 await page.goto('http://regie.test/');
 await page.evaluate(async()=>{
  window.saved={id:'r1',jobId:'26082',date:'2026-09-11',reportSequence:19,status:'completed',processingStatus:'archived',description:'Gewebe',hourlyRate:75,materialMarkup:50,employees:[{id:'1',name:'Clemens',from:'07:00',to:'11:53',hours:5}],materials:[{materialId:'m1',product:'Kleber',unit:'Sack',containerSize:20,quantity:2,purchasePrice:22.17,salePrice:33.26,markup:50}],attachments:[]};
  jobs=[{jobId:'26082',name:'Test'}];allEmployees=[{id:'1',name:'Clemens'}];materials=[{...saved.materials[0]}];
  window.writes=[];api=async(url,options)=>{if(url.endsWith('/save')){const body=JSON.parse(options.body);writes.push(body);saved={...saved,...body};return {report:saved}}if(url==='/admin/api/materials')return {materials:[{...materials[0],unit:'kg'}]};return {reports:[saved],suggestions:[],recipients:[]}};
  await openReport(saved);
 });
 assert(await page.locator('#saveDraft').isVisible());
 await page.locator('.emp-to-1').fill('12:00');await page.locator('.mat-unit').fill('kg');await page.locator('.mat-qty').fill('40');
 await page.locator('#saveDraft').click();await page.waitForFunction(()=>writes.length===1&&!savingReport);
 await page.locator('#closeEditor').click();await page.evaluate(()=>openReport(saved));
 assert.equal(await page.locator('.emp-to-1').inputValue(),'12:00');assert.equal(await page.locator('.mat-unit').inputValue(),'kg');assert.equal(await page.locator('.mat-qty').inputValue(),'40');
 await page.locator('.emp-to-1').fill('12:15');await page.locator('.mat-unit').click();
 await page.evaluate(()=>{window.open=()=>({location:{set href(value){window.printSnapshot={url:value,time:saved.employees[0].to,unit:saved.materials[0].unit}}},close(){}})});
 await page.locator('#printReport').click();await page.waitForFunction(()=>window.printSnapshot);
 assert.deepEqual(await page.evaluate(()=>[printSnapshot.time,printSnapshot.unit,writes.at(-1).correctReport]),['12:15','kg',true]);
 await page.evaluate(async()=>{current.materials[0].unit='Sack';materials[0].unit='Sack';editedMaterial={materialId:'m1',reportId:current.id,unit:'Sack',containerSize:20};await refreshEditedMaterial()});
 assert.equal(await page.locator('.mat-unit').inputValue(),'kg');
 assert.deepEqual(errors,[]);console.log('OK: Archived report corrections save, reopen and precede PDF; edited master unit refreshes.');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
