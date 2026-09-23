"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("one personal WhatsApp login opens KrisDrive and LG, while roles and write origin stay server-controlled", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-login-"));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_TOKEN = "legacy-machine-secret";
  process.env.KRISTINE_PERSONAL_LOGIN_ENABLED = "true";
  const people = [
    { id:"alex", name:"Alexander Krista", phone:"+43 660 111111", active:true, kristineAccess:true },
    { id:"mario", name:"Mario", phone:"+43 660 222222", active:true, kristineAccess:true },
    { id:"lutz", name:"Lutz", phone:"+43 660 333333", active:true },
  ];
  await fs.mkdir(path.join(dir, "_system"), { recursive:true });
  await fs.writeFile(path.join(dir, "_system", "employees.json"), JSON.stringify(people));

  require("../krisdrive-live-preload");
  const { installRoutes } = require("../access-bridge-cloud");
  const express = require("express");
  const { registerPaintLab } = require("../paint-lab");
  const { registerEmployeeLogin } = require("../employee-login");
  const { registerKristineUserAccess } = require("../kristine-user-access");
  const messages = [];
  const app = express();
  app.use(express.json());
  installRoutes(app);
  registerEmployeeLogin(app, { dataDir:dir, readEmployees:async()=>people, sendWhatsApp:async row=>messages.push(row) });
  registerKristineUserAccess(app, { dataDir:dir, readEmployees:async()=>people, requireAdmin:require("../admin-auth").requireAdmin });
  registerPaintLab(app, { dataDir:dir });
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, opts={}) => fetch(base+url, opts);
  const post = (url, body, headers={}) => request(url, { method:"POST", headers:{ Origin:base, "Content-Type":"application/json", ...headers }, body:JSON.stringify(body) });

  assert.equal((await request("/kristine/api/krisdrive/live")).status, 403);
  assert.equal((await request("/admin/api/paint/status")).status, 403);
  const legacy = await request("/kristine/api/access-status?token=legacy-machine-secret");
  assert.equal(legacy.status, 200);
  const legacyCookie = legacy.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/kristine/api/krisdrive/live", { headers:{ Cookie:legacyCookie } })).status, 200);
  assert.equal((await request("/admin/api/paint/status", { headers:{ Cookie:legacyCookie } })).status, 200);
  assert.equal((await post("/kristine/api/access-heartbeat", {}, { Cookie:legacyCookie })).status, 403);

  assert.equal((await post("/auth/whatsapp/start", { phone:"+43 660 333333" })).status, 200);
  assert.equal(messages.length, 0, "KGO-only employee must not receive a KRISTINE code");

  async function login(phone) {
    const start = await post("/auth/whatsapp/start", { phone });
    assert.equal(start.status, 200);
    const code = messages.at(-1).reply.match(/\b\d{6}\b/)[0];
    assert.equal((await post("/auth/whatsapp/verify", { phone, code:"00000x" })).status, 401);
    const verify = await post("/auth/whatsapp/verify", { phone, code });
    assert.equal(verify.status, 200);
    return verify.headers.get("set-cookie").split(";")[0];
  }
  const mario = await login("+43 660 222222");
  assert.equal((await request("/kristine/api/krisdrive/live", { headers:{ Cookie:mario } })).status, 200);
  assert.equal((await request("/admin/api/paint/status", { headers:{ Cookie:mario } })).status, 200);
  const me = await (await request("/auth/me", { headers:{ Cookie:mario } })).json();
  assert.equal(me.user.id, "mario");
  assert.equal(me.user.role, "user");
  const forged = await request("/kristine/api/user-access", { method:"PUT", headers:{ Cookie:mario, Origin:base, "Content-Type":"application/json", "X-Krista-User-Id":"alex" }, body:JSON.stringify({ actorId:"alex", users:[] }) });
  assert.equal(forged.status, 403);
  const crossOrigin = await request("/admin/api/paint/settings", { method:"PUT", headers:{ Cookie:mario, Origin:"https://attacker.example", "Content-Type":"application/json" }, body:"{}" });
  assert.equal(crossOrigin.status, 403);
  const alex = await login("+43 660 111111");
  const authorized = await request("/kristine/api/user-access", { method:"PUT", headers:{ Cookie:alex, Origin:base, "Content-Type":"application/json" }, body:JSON.stringify({ users:[] }) });
  assert.equal(authorized.status, 200);
  assert.equal((await post("/auth/logout", {}, { Cookie:alex })).status, 200);
  assert.equal((await request("/auth/me", { headers:{ Cookie:alex } })).status, 401);
  people[1].kristineAccess = false;
  await fs.writeFile(path.join(dir, "_system", "employees.json"), JSON.stringify(people));
  assert.equal((await request("/auth/me", { headers:{ Cookie:mario } })).status, 401);
});
