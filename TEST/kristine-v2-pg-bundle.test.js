'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool,Client}=require('../tools/kristine-v2-pg-bundle.cjs');

test('bundled postgres driver is available with no Render npm build step',()=>{
  assert.equal(typeof Pool,'function');
  assert.equal(typeof Client,'function');
  const docs=path.join(__dirname,'..','tools','kristine-v2-pg-THIRD-PARTY-NOTICES.md');
  assert.match(fs.readFileSync(docs,'utf8'),/pg 8\.16\.3/);
  const licenses=fs.readdirSync(path.join(__dirname,'..','tools','kristine-v2-pg-licenses'));
  assert.ok(licenses.includes('pg.txt'));
  assert.ok(licenses.includes('pg-protocol.txt'));
  assert.ok(licenses.includes('pg-int8.txt'));
});
