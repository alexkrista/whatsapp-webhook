"use strict";

const Module = require("module");
const originalLoad = Module._load;
let wrapped = false;

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function withChefPhoneFallback(options = {}) {
  const chefPhone = String(options.chefPhoneNumber || "").replace(/\D/g, "");
  const originalReadEmployees = options.readEmployees;
  if (!chefPhone || typeof originalReadEmployees !== "function") return options;

  return {
    ...options,
    readEmployees: async (...args) => {
      const employees = await originalReadEmployees(...args);
      return (employees || []).map((employee) => {
        const currentPhone = String(employee?.phone || "").replace(/\D/g, "");
        if (currentPhone) return employee;

        const officialName = normalizeName(employee?.name || employee?.employeeName || "");
        const nickname = normalizeName(employee?.nickname || employee?.rufname || "");
        const isAlexanderKrista =
          officialName === "alexander krista" ||
          officialName === "alex krista" ||
          (officialName.endsWith(" krista") && (nickname === "alex" || nickname === "alexander"));

        return isAlexanderKrista ? { ...employee, phone: chefPhone } : employee;
      });
    },
  };
}

Module._load = function kristineInboxLoader(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  if (!wrapped && (request === "./kristine" || request.endsWith("/kristine")) && exported && typeof exported.registerKristine === "function") {
    wrapped = true;
    const originalRegister = exported.registerKristine;
    const { registerKristineInbox } = require("./kristine-inbox");
    const { registerKristineInvoiceIntake } = require("./kristine-invoice-intake");
    exported.registerKristine = function registerKristineWithInbox(app, options) {
      const effectiveOptions = withChefPhoneFallback(options);
      const result = originalRegister(app, effectiveOptions);
      const shared = { dataDir: effectiveOptions.dataDir, requireAdmin: effectiveOptions.requireAdmin };
      registerKristineInbox(app, shared);
      registerKristineInvoiceIntake(app, shared);
      return result;
    };
  }
  return exported;
};
