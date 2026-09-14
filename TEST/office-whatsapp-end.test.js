"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "office-whatsapp-end-"));
  const kristinePath = require.resolve("../kristine");
  const officePath = require.resolve("../kgo-office-whatsapp");
  const originalKristine = require.cache[kristinePath];
  try {
    await fsp.mkdir(path.join(root, "_kristine"));
    await fsp.writeFile(path.join(root, "_kristine", "time-events.json"), JSON.stringify([
      {employeeId:"384",employeeName:"Bettina",date:"2026-09-14",type:"up",at:"07:48",jobId:"022",unproductiveCode:"022",createdAt:"2026-09-14T05:48:00.000Z"}
    ]));

    const fakeKristine = {
      registerKristine() {
        return {handleMessage:async () => { throw new Error("office request fell through"); }};
      }
    };
    require.cache[kristinePath] = {id:kristinePath,filename:kristinePath,loaded:true,exports:fakeKristine};
    delete require.cache[officePath];
    require(officePath);

    const instance = fakeKristine.registerKristine({}, {
      dataDir:root,
      readEmployees:async () => [{id:"384",name:"Bettina Eberle-Nigsch",worktimeModelId:"office-bettina"}]
    });
    const result = await instance.handleMessage({employeeId:"384",text:"Ende",date:"2026-09-14"});
    assert.match(result.reply, /Ausgestempelt/);
    const saved = JSON.parse(await fsp.readFile(path.join(root,"_kristine","time-events.json"),"utf8"));
    assert.equal(saved.at(-1).type,"ende");
    assert.equal(saved.at(-1).jobId,"022");
    console.log("OK: WhatsApp Ende recognizes normalized office UP start.");
  } finally {
    delete require.cache[officePath];
    if (originalKristine) require.cache[kristinePath] = originalKristine;
    else delete require.cache[kristinePath];
    await fsp.rm(root,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
