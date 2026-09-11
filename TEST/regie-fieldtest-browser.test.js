const fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  let html=fs.readFileSync(path.join(__dirname,'../public/regie-assistant.html'),'utf8');
  html=html.replace("init().catch(e=>{fail(e.message);$('next').disabled=true});",'');
  await page.route('http://regie.test/**',route=>route.fulfill({contentType:route.request().url().includes('.js')?'text/javascript':'text/html; charset=utf-8',body:route.request().url().includes('regie-upload.js')?fs.readFileSync(path.join(__dirname,'../public/ui/regie-upload.js'),'utf8'):route.request().url().includes('.js')?'':html}));
  await page.addInitScript(()=>{window.SpeechRecognition=class {constructor(){window.testSpeech=this}start(){}stop(){this.onend?.()}}});
  await page.goto('http://regie.test/');
  const result=await page.evaluate(async()=>{
   $('speak').onclick();const results=[Object.assign([{transcript:'Gewebe eingespachtelt.'}],{isFinal:true})];testSpeech.onresult({resultIndex:0,results});testSpeech.onresult({resultIndex:0,results});stopSpeech();
   const speech=$('description').value;
   segment={jobId:'26082'};peopleData=[{id:'1',name:'Test',selected:true,from:'07:00',to:'12:00',bookedTo:'11:53',netMinutes:293,hours:5,bookedBlocks:[{from:'07:00',to:'11:53'}]}];
   const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=2000;canvas.getContext('2d').fillRect(0,0,3000,2000);
   const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
   photoFiles=Array.from({length:10},(_,i)=>new File([blob],`photo-${i}.png`,{type:'image/png'}));
   const prepared=await RegieUpload.prepare(photoFiles[0]);const img=new Image();img.src=prepared.data;await img.decode();
   let report={id:'test',attachmentUploadToken:'cap',status:'draft',photos:[],materials:[]},attempts=0,failed=false,finals=0;
   api=async(url,options)=>{const body=JSON.parse(options.body);if(url.endsWith('/attachments')){attempts++;if(attempts===4&&!failed){failed=true;throw Error('Test interruption')}report.photos.push({name:body.upload.name});return {report}}if(body.uploads.length)throw Error('Unexpected combined upload');if(!body.draft){finals++;report.status='prepared'}return {report}};
   let message='';try{await submit(false)}catch(e){message=e.message}
   const pendingAfterFailure=photoFiles.length,storedAfterFailure=report.photos.length;
   await submit(false);
   return {speech,width:img.naturalWidth,height:img.naturalHeight,size:prepared.data.length,pendingAfterFailure,storedAfterFailure,message,attempts,finals,photos:report.photos.length,unique:new Set(report.photos.map(x=>x.name)).size,pending:photoFiles.length};
  });
  assert.equal(result.speech,'Gewebe eingespachtelt.');
  assert.equal(result.width,2000);assert.equal(result.height,1333);
  assert.equal(result.pendingAfterFailure,7);assert.equal(result.storedAfterFailure,3);
  assert.match(result.message,/Entwurf/);assert.equal(result.attempts,11);
  assert.equal(result.finals,1);assert.equal(result.photos,10);assert.equal(result.unique,10);assert.equal(result.pending,0);
  console.log('OK: Browser compresses photos, resumes interrupted sequential uploads and inserts each dictated phrase once.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
