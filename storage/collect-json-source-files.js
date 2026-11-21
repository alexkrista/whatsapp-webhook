'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const excludedDirs=new Set(['_sql-import-originals','node_modules','browser-sessions','login-challenges','customer-access']);
const excludedName=n=>/(token|credential|secret|password)/i.test(n)||['access-admin.json','enable-banking-personal.json'].includes(n)||/(^|[.])(?:bak|backup)([.]|$)/i.test(n);
async function collectJsonSourceFiles(root){const files=[],excluded=[],links=[];async function walk(dir,rel=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){const r=path.posix.join(rel,e.name),p=path.join(dir,e.name);if(excludedDirs.has(e.name)||excludedName(e.name)){excluded.push(r);continue;}if(e.isSymbolicLink()){links.push({path:r,target:await fs.readlink(p)});continue;}if(e.isDirectory()){await walk(p,r);continue;}if(e.isFile()&&(e.name.endsWith('.json')||e.name.endsWith('.jsonl'))){const originalText=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(p));files.push({path:r,originalText});}}}await walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));return{files,excluded,links};}
module.exports={collectJsonSourceFiles};
