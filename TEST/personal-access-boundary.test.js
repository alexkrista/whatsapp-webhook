"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { personalLoginAllowed, personalLoginEnabled } = require('../employee-login-policy');
const { requireAdmin } = require('../admin-auth');

test('personal login modes fail closed and Alexander-only ignores employee grants', t => {
  const previous = process.env.KRISTINE_PERSONAL_LOGIN_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.KRISTINE_PERSONAL_LOGIN_ENABLED; else process.env.KRISTINE_PERSONAL_LOGIN_ENABLED = previous; });
  for (const mode of ['', 'false', 'TRUE', 'unknown']) {
    process.env.KRISTINE_PERSONAL_LOGIN_ENABLED = mode;
    assert.equal(personalLoginEnabled(), false);
    assert.equal(personalLoginAllowed({name:'Alexander Krista',kristineAccess:true}), false);
  }
  process.env.KRISTINE_PERSONAL_LOGIN_ENABLED = 'true';
  for (const grant of [undefined, false, 'true', 1]) {
    assert.equal(personalLoginAllowed({name:'Alexander Krista',kristineAccess:grant}), false);
  }
  assert.equal(personalLoginAllowed({kristineAccess:true}), true);
  assert.equal(personalLoginAllowed({active:false,kristineAccess:true}), false);
  process.env.KRISTINE_PERSONAL_LOGIN_ENABLED = 'alexander';
  assert.equal(personalLoginAllowed({name:'Alexander Krista',kristineAccess:false}), true);
  assert.equal(personalLoginAllowed({name:'Bettina',kristineAccess:true}), false);
  assert.equal(personalLoginAllowed({name:'Alexander Krista',active:false}), false);
});

test('shared credentials cannot grant personal permissions, technical read access remains available', () => {
  const secret = 'synthetic-admin-secret';
  const cookie = 'kristine_session=' + require('node:crypto').createHmac('sha256', secret).update('kristine-browser-session-v1').digest('base64url');
  for (const [path, method] of [
    ['/admin/api/brain-permit','GET'], ['/admin/api/employees/123','PUT'],
    ['/kristine/api/user-access','PUT'], ['/kristine/api/assignments','POST'],
    ['/admin/api/access/open','POST'],
  ]) {
    for (const credentials of [{query:{token:secret}}, {headers:{'x-admin-token':secret}}, {headers:{cookie}}]) {
      const req = {path,method,headers:{origin:'https://example.test',host:'example.test','x-krista-user-id':'alex',...credentials.headers},query:credentials.query||{}};
      const res = {status(code){this.code=code;return this;},json(){}};
      assert.equal(requireAdmin(req,res,{secret}),false,`${method} ${path}`);
      assert.equal(res.code,403);
    }
  }
  assert.equal(requireAdmin({path:'/admin/api/paint/status',method:'GET',headers:{'x-admin-token':secret},query:{}},{},{secret,rememberBrowser:false}),true);
});
