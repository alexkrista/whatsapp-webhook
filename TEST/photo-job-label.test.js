const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Nameless jobs resolve both current labels and previously selected labels with separator',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../public/ui/photo-inbox.js'),'utf8'),start=text.indexOf(' const normalizeJob='),end=text.indexOf(' const picker=',start),context=vm.createContext({jobs:[{jobId:'keckeis_gabi_harry',name:''},{jobId:'26080',name:'  Fink  Loos  '},{jobId:'26081',name:'Doppelt'},{jobId:'26082',name:'Doppelt'}]});vm.runInContext(text.slice(start,end)+';globalThis.resolve=resolveJob;globalThis.label=jobLabel;',context);
 for(const value of ['keckeis_gabi_harry','keckeis_gabi_harry · ','keckeis_gabi_harry ·',' KECKEIS_GABI_HARRY  ·  '])assert.equal(context.resolve(value),'keckeis_gabi_harry');
 assert.equal(context.label(context.jobs[0]),'keckeis_gabi_harry');assert.equal(context.resolve('26080 · Fink Loos'),'26080');assert.equal(context.resolve('Doppelt'),'');assert.equal(context.resolve('keckeis_gabi'),'');assert.equal(context.resolve(''),'');
});
