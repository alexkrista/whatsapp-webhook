'use strict';

const fsp=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');

const VALID_STATUSES=new Set(['accepted','sent','delivered','read','failed','deleted']);
const STATUS_RANK={accepted:0,sent:1,delivered:2,read:3,failed:4,deleted:5};

function keyOf(id) {
  if(typeof id!=='string' || !id.startsWith('wamid.') || id.length>512) return '';
  return createHash('sha256').update(id).digest('hex').slice(0,24);
}
function digitsTail(value) {
  return String(value||'').replace(/\D/g,'').slice(-6);
}
function statusEvent(row,receivedAt) {
  const idKey=keyOf(row?.id);
  const status=String(row?.status||'').toLowerCase();
  if(!idKey||!VALID_STATUSES.has(status)||status==='accepted')return null;
  const code=Number(row?.errors?.[0]?.code);
  return {
    at:receivedAt,
    key:idKey,
    status,
    recipientTail:digitsTail(row?.recipient_id),
    ...(status==='failed'&&Number.isSafeInteger(code)&&code>0?{metaCode:code}:{}),
  };
}
function acceptedEvent({id,to,payloadType,purpose},at) {
  const key=keyOf(id);
  if(!key)return null;
  const normalizedPurpose=String(purpose||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,35);
  return {
    at,key,status:'accepted',recipientTail:digitsTail(to),
    payloadType:['text','interactive','template'].includes(payloadType)?payloadType:'other',
    purpose:normalizedPurpose||'unspecified',
  };
}

function createWhatsAppDeliveryAudit(dataDir,{logger=console,clock=()=>new Date()}={}) {
  if(typeof dataDir!=='string'||!dataDir)throw new TypeError('dataDir required');
  const root=path.join(dataDir,'_kristine','whatsapp-delivery-audit');
  async function write(row){
    const day=row.at.slice(0,10);
    await fsp.mkdir(root,{recursive:true});
    await fsp.appendFile(path.join(root,day+'.jsonl'),JSON.stringify(row)+'\n','utf8');
  }
  async function recordAccepted(args){
    const row=acceptedEvent(args,clock().toISOString());
    if(row)await write(row);
    return row;
  }
  async function recordStatuses(input){
    if(!Array.isArray(input))return 0;
    let count=0;
    for(const candidate of input){
      const row=statusEvent(candidate,clock().toISOString());
      if(!row)continue;
      await write(row);
      count++;
      if(row.status==='failed')logger.error?.('WHATSAPP_DELIVERY_FAILED',{
        key:row.key,recipientTail:row.recipientTail,code:row.metaCode||null,
      });
    }
    return count;
  }
  async function latest({days=4,limit=100}={}){
    if(!Number.isInteger(days)||days<1||days>14||!Number.isInteger(limit)||limit<1||limit>500)throw new TypeError('Invalid audit pagination');
    const rows=[];
    const end=clock();
    for(let i=0;i<days;i++){
      const day=new Date(end.valueOf()-i*86_400_000).toISOString().slice(0,10);
      let body;
      try{body=await fsp.readFile(path.join(root,day+'.jsonl'),'utf8')}
      catch(err){if(err?.code==='ENOENT')continue;throw err}
      for(const line of body.split('\n')){
        if(!line.trim())continue;
        try {
          const r=JSON.parse(line);
          if(r&&typeof r.key==='string'&&VALID_STATUSES.has(r.status)) rows.push(r);
        } catch { /* Skip incomplete final line only, no silent mutation. */ }
      }
    }
    rows.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    const combined=new Map();
    for(const row of rows){
      const current=combined.get(row.key)||{
        id:row.key,status:'accepted',acceptedAt:null,lastUpdateAt:null,
        recipientTail:'',purpose:'unspecified',payloadType:'unknown',metaCode:null,
      };
      if(row.status==='accepted'){
        current.acceptedAt=current.acceptedAt||row.at;
        current.purpose=row.purpose||current.purpose;
        current.payloadType=row.payloadType||current.payloadType;
      }
      if(!current.recipientTail && row.recipientTail) current.recipientTail=row.recipientTail;
      if(row.status!=='accepted' && STATUS_RANK[row.status]>=STATUS_RANK[current.status]){
        current.status=row.status;
        current.lastUpdateAt=row.at;
        if(row.status==='failed')current.metaCode=row.metaCode||null;
      }
      combined.set(row.key,current);
    }
    // A public webhook must never create an apparent delivery of an
    // unrecognized message. Only outbound IDs previously acknowledged by Meta
    // and recorded by this process may appear in the operator report.
    const known=[...combined.values()].filter(v=>Boolean(v.acceptedAt));
    const values=known.sort((a,b)=>String(b.lastUpdateAt||b.acceptedAt).localeCompare(String(a.lastUpdateAt||a.acceptedAt))).slice(0,limit);
    const counts={accepted:0,sent:0,delivered:0,read:0,failed:0,deleted:0};
    for(const v of known)counts[v.status]++;
    return {ok:true,source:'meta_status_webhook',totals:counts,rows:values};
  }
  return {recordAccepted,recordStatuses,latest};
}

module.exports={createWhatsAppDeliveryAudit,acceptedEvent,statusEvent,keyOf};
