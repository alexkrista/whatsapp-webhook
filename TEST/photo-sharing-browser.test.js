const fs=require('fs'),path=require('path'),assert=require('assert'),{chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();let sent=null;
 await page.addInitScript(()=>{Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.shared={count:data.files.length,text:data.text}}})});
 await page.route('http://photos.test/**',route=>{const url=new URL(route.request().url());
 if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="bkProtocols"></div><script src="/gallery.js"></script>'});
 if(url.pathname==='/gallery.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'../public/ui/baustellen-foto-gallery.js'),'utf8')});
 if(url.pathname.endsWith('/email')){sent=route.request().postDataJSON();return route.fulfill({json:{ok:true,count:2}})}
 if(url.pathname.endsWith('/share-file'))return route.fulfill({contentType:'image/jpeg',body:Buffer.from([255,216,255,217])});
 if(url.pathname.endsWith('/media'))return route.fulfill({json:{media:[0,1].map(i=>({id:String(i),date:'2026-08-21',file:'photo'+i+'.jpg',url:'/image.jpg',kind:'photo'}))}});
 return route.fulfill({body:''});});
 await page.goto('http://photos.test/#26091');await page.locator('[data-bf-select-day]').check();
 await page.getByRole('button',{name:'Per E-Mail',exact:true}).click();await page.locator('[data-to]').fill('kunde@example.test');assert.equal(sent,null);
 await page.getByRole('button',{name:'E-Mail senden',exact:true}).click();await page.getByText('2 Fotos wurden per E-Mail versendet.').waitFor();assert.equal(sent.to,'kunde@example.test');assert.equal(sent.files.length,2);await page.locator('dialog [data-close]').click();
 await page.getByRole('button',{name:'WhatsApp',exact:true}).click();await page.getByRole('button',{name:'Teilen – WhatsApp wählen'}).click();assert.equal(await page.evaluate(()=>shared.count),2);await page.locator('dialog [data-close]').click();
 await page.evaluate(()=>Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false}));await page.getByRole('button',{name:'WhatsApp',exact:true}).click();await page.getByRole('button',{name:'WhatsApp öffnen'}).waitFor();assert.equal(await page.locator('dialog a[download]').count(),2);
 console.log('OK: Email requires send click, native file sharing and desktop download fallback work.');
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
