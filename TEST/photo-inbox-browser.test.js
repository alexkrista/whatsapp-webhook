const fs=require('fs'),path=require('path'),assert=require('assert'),{chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();let confirmed=false,changes=null;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://inbox.test/**',route=>{const u=new URL(route.request().url());
 if(u.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<main class="shell"><div class="hero"></div></main><script src="/photos.js"></script>'});
 if(u.pathname==='/photos.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'../public/ui/photo-inbox.js'),'utf8')});
 if(u.pathname==='/admin/api/jobs')return route.fulfill({json:{jobs:[{jobId:'26080',name:'Baustelle A'},{jobId:'26091',name:'Baustelle B'}]}});
 if(u.pathname.endsWith('/confirm')){changes=route.request().postDataJSON().changes;confirmed=true;return route.fulfill({json:{ok:true,count:2}})}
 if(u.pathname==='/kristine/api/photo-inbox')return route.fulfill({json:{items:confirmed?[]:[0,1].map(i=>({groupId:'g1',file:'photo'+i+'.jpg',url:'/image.jpg',employeeName:'Clemens',date:'2026-09-12',at:'10:00',category:'photo',suggestion:{jobId:i?'':'26080',reason:i?'Keine Stempelung':'Stempelung um 07:00'}}))}});
 return route.fulfill({body:''});});
 await page.goto('http://inbox.test/?photoGroup=g1');await page.locator('[data-group]').waitFor();assert.equal(await page.locator('[data-job]').first().inputValue(),'26080');
 await page.getByRole('button',{name:'Zuordnungen bestätigen'}).click();assert.equal(changes,null);await page.getByText('Bitte für jedes Foto eine Baustelle wählen.').waitFor();
 await page.locator('[data-all]').selectOption('26091');await page.getByRole('button',{name:'Zuordnungen bestätigen'}).click();await page.getByText('Keine Fotos zur Zuordnung offen.').waitFor();
 assert.equal(changes.length,2);assert(changes.every(c=>c.jobId==='26091'));assert.deepEqual(errors,[]);console.log('OK: Fotoeingang shows proposals, requires missing assignments and confirms the grouped photos.');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
