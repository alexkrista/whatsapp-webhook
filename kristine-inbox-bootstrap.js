"use strict";

const Module = require("module");
const originalLoad = Module._load;
let wrapped = false;

Module._load = function kristineInboxLoader(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  if (!wrapped && (request === "./kristine" || request.endsWith("/kristine")) && exported && typeof exported.registerKristine === "function") {
    wrapped = true;
    const originalRegister = exported.registerKristine;
    const { registerKristineInbox } = require("./kristine-inbox");
    exported.registerKristine = function registerKristineWithInbox(app, options) {
      const result = originalRegister(app, options);
      registerKristineInbox(app, { dataDir: options.dataDir, requireAdmin: options.requireAdmin });
      return result;
    };
  }
  return exported;
};
