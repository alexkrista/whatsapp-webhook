'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requirePaintLgSync}=require('../paint-lg-service-auth');
test('LG service token grants only receipt intake and turnover, never stock confirmation or other admin routes',()=>{
 process.env.KRISTINE_LG_SYNC_TOKEN='service-test';process.env.ADMIN_TOKEN='admin-test';
 const response=()=>({status(c){this.code=c;return this},json(x){this.body=x;return this}});
 for(const path of ['/admin/api/paint/lg-incoming-sync','/admin/api/paint/lg-purchase'])assert.equal(requirePaintLgSync({method:'POST',path,headers:{'x-krista-lg-sync-token':'service-test'}},response()),true);
 for(const [method,path,key] of [['POST','/admin/api/paint/goods-receipts/test/confirm','service-test'],['GET','/admin/api/paint/lg-purchase','service-test'],['POST','/admin/api/paint/lg-incoming-sync','wrong'],['POST','/admin/api/paint/lg-incoming-sync','']])assert.equal(requirePaintLgSync({method,path,headers:{'x-krista-lg-sync-token':key}},response()),false);
});
