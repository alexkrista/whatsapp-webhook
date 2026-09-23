"use strict";
const {timingSafeEqual} = require('crypto');
const allowed = new Set(['/admin/api/paint/lg-incoming-sync','/admin/api/paint/lg-purchase']);
function requirePaintLgSync(req,res) {
  const expected=process.env.KRISTINE_LG_SYNC_TOKEN||'';
  const supplied=String(req.headers?.['x-krista-lg-sync-token']||'');
  const pathname=String(req.path||req.originalUrl||'').split('?')[0];
  if(req.method==='POST'&&allowed.has(pathname)&&expected&&supplied){
    const a=Buffer.from(expected),b=Buffer.from(supplied);
    if(a.length===b.length&&timingSafeEqual(a,b))return true;
  }
  return require('./admin-auth').requireAdmin(req,res);
}
module.exports={requirePaintLgSync};
