/* Small, sequential uploads shared by KGO and the office report editor. */
(function(){
 'use strict';
 const cache=new WeakMap();
 const read=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Datei konnte nicht gelesen werden.'));r.readAsDataURL(blob)});
 async function prepare(entry){
  const file=entry.file||entry,name=entry.uploadName||file.name;
  if(!cache.has(file))cache.set(file,(async()=>{
   let blob=file;
   if(file.type.startsWith('image/')){
    const url=URL.createObjectURL(file),img=new Image();
    try{
     await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Bildformat nicht lesbar. Bitte als JPEG senden.'));img.src=url});
     const scale=Math.min(1,2000/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');
     canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
     const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
     const compressed=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));
     if(compressed&&(compressed.size<file.size||scale<1||!/^image\/(jpeg|png|webp)$/.test(file.type)))blob=compressed;
    }finally{URL.revokeObjectURL(url)}
   }
   if(blob.size>8*1024*1024)throw Error('Datei ist größer als 8 MB. Bitte verkleinern oder separat nachreichen.');
   return {data:await read(blob),type:blob.type};
  })().catch(error=>{cache.delete(file);throw error}));
  return {name,...await cache.get(file)};
 }
 async function send(report,entry,api){
  try{
   const upload=await prepare(entry);
   return (await api('/kristine/api/regie-reports/'+encodeURIComponent(report.id)+'/attachments',{method:'POST',body:JSON.stringify({upload,uploadToken:report.attachmentUploadToken||''})})).report;
  }catch(error){throw Error((entry.uploadName||(entry.file||entry).name)+': '+error.message+' Der Bericht bleibt als Entwurf gespeichert. Erneut senden setzt bei den fehlenden Dateien fort.')}
 }
 window.RegieUpload={prepare,send};
})();
