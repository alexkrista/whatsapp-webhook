"use strict";
const fs = require("fs/promises");
const path = require("path");

function createWhatsAppInbox(dataDir) {
  const file = path.join(dataDir, "_kristine", "whatsapp-unread.json");
  let queue = Promise.resolve();
  async function load() {
    try { const rows=JSON.parse(await fs.readFile(file,"utf8")); return Array.isArray(rows)?rows:[]; }
    catch(error) { if(error.code==="ENOENT") return []; throw error; }
  }
  function update(fn) {
    const task = queue.then(async () => {
      const rows=await load(),result=fn(rows);
      await fs.mkdir(path.dirname(file),{recursive:true});
      const tmp=file+".tmp";
      await fs.writeFile(tmp,JSON.stringify(rows.slice(-2500)),"utf8");
      await fs.rename(tmp,file);
      return result;
    });
    queue=task.catch(()=>{});
    return task;
  }
  async function record(msg) {
    const id=String(msg?.id||"").slice(0,160);
    if(!id) return;
    return update(rows=>{
      if(rows.some(row=>row.id===id))return;
      const text=String(msg.text?.body||msg.image?.caption||msg.document?.caption||
        msg.video?.caption||msg.button?.text||msg.interactive?.button_reply?.title||
        msg.interactive?.list_reply?.title||"").slice(0,1200);
      rows.push({id,from:String(msg.from||"").slice(0,32),type:String(msg.type||"text").slice(0,40),
        text,receivedAt:new Date(Number(msg.timestamp)*1000||Date.now()).toISOString(),readAt:null});
    });
  }
  async function list() {
    await queue;
    const rows=await load(),unread=rows.filter(x=>!x.readAt);
    return {ok:true,count:unread.length,items:unread.slice(-100).reverse()};
  }
  async function markRead(ids) {
    const keys=new Set((Array.isArray(ids)?ids:[]).map(x=>String(x)).slice(0,150));
    return update(rows=>{
      const now=new Date().toISOString();
      for(const row of rows) if(keys.has(row.id))row.readAt=now;
      return {ok:true,count:rows.filter(x=>!x.readAt).length};
    });
  }
  return {record,list,markRead};
}
module.exports={createWhatsAppInbox};
