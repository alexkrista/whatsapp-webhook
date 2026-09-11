const fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  let item={materialId:'A1',product:'Offizieller Artikel',alias:'Feine Spachtel <img src=x>',unit:'kg',purchasePrice:10,salePrice:20};
  await page.route('http://materials.test/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(__dirname,'../public/material-admin.html'),'utf8')});
   if(url.pathname.endsWith('.js'))return route.fulfill({contentType:'text/javascript',body:''});
   let data={ok:true};
   if(request.method()==='PUT'){const body=request.postDataJSON();writes.push(body);item={...item,...body};data.material=item;}
   else if(url.pathname==='/admin/api/materials')data={ok:true,materials:[item],summary:{byGroup:{},bySupplier:{},activeCount:1,stalePriceCount:0,inboxOpenCount:1}};
   else if(url.pathname==='/admin/api/material-inbox')data={ok:true,items:[{id:'U1',description:'Baustellenname',productSuggestion:'Offizieller Name',groupSuggestion:'Material'}]};
   else if(url.pathname==='/kristine/api/material-requests')data={ok:true,requests:[]};
   return route.fulfill({json:data});
  });
  await page.goto('http://materials.test/');await page.waitForFunction(()=>document.getElementById('materialRows').children.length===1);
  await page.locator('#tabMaterials').click();
  assert((await page.locator('#materialRows').textContent()).includes('Feine Spachtel'));
  assert.equal(await page.locator('#materialRows img').count(),0);
  await page.getByRole('button',{name:'Bearbeiten',exact:true}).click();
  assert.equal(await page.locator('#editAlias').inputValue(),item.alias);
  await page.locator('#editAlias').fill('Finish; Feinspachtel');
  await page.locator('#materialDialog').getByRole('button',{name:'Speichern',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('materialDialog').open);
  assert.equal(writes[0].alias,'Finish; Feinspachtel');assert.equal(writes[0].product,'Offizieller Artikel');
  await page.getByRole('button',{name:'Bearbeiten',exact:true}).click();await page.locator('#editAlias').fill('');
  await page.locator('#materialDialog').getByRole('button',{name:'Speichern',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('materialDialog').open);assert.equal(writes[1].alias,'');
  await page.locator('#tabInbox').click();await page.getByRole('button',{name:'Einmal sauber anlegen',exact:true}).click();
  assert.equal(await page.locator('#learnAlias').inputValue(),'Baustellenname');
  assert.deepEqual(errors,[]);
  console.log('PASS browser: alias column, safe text, edit/save/delete, unchanged official name and learning suggestion');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
