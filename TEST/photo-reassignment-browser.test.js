const fs=require('fs'),path=require('path'),assert=require('assert'),{chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();let moved=false,submitted;
 await page.route('http://photos.test/**',route=>{const url=new URL(route.request().url());
 if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="bkProtocols"></div><script src="/gallery.js"></script>'});
 if(url.pathname==='/gallery.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'../public/ui/baustellen-foto-gallery.js'),'utf8')});
 if(url.pathname.endsWith('/reassign')){submitted=route.request().postDataJSON();moved=true;return route.fulfill({json:{ok:true,count:2}})}
 if(url.pathname==='/admin/api/jobs')return route.fulfill({json:{jobs:[{jobId:'26091',name:'Source'},{jobId:'26080',name:'Target'}]}});
 if(url.pathname.endsWith('/media'))return route.fulfill({json:{media:moved?[]:[0,1].map(i=>({id:String(i),date:'2026-08-21',employeeName:'Clemens',file:'photo'+i+'.jpg',url:'/image.jpg',kind:'photo'}))}});
 return route.fulfill({body:''});});
 await page.goto('http://photos.test/#26091');await page.locator('[data-bf-select-day]').check();
 assert.equal(await page.locator('[data-bf-select]:checked').count(),2);
 await page.getByRole('button',{name:'Baustelle ändern',exact:true}).click();await page.locator('[data-target]').selectOption('26080');
 await page.getByRole('button',{name:'Zuordnung speichern',exact:true}).click();await page.getByText('Für diese Baustelle sind derzeit keine einzelnen Fotos oder Videos gespeichert.').waitFor();
 assert.deepEqual(submitted,{targetJobId:'26080',files:['photo0.jpg','photo1.jpg']});console.log('OK: Select day, choose destination, save assignment and refresh source gallery.');
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
