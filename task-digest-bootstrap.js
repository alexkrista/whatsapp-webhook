"use strict";

const Module = require("module");
const originalLoad = Module._load;
let wrapped = false;

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
  return digits;
}

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isAlexEmployee(employee) {
  const identity = [employee?.name, employee?.employeeName, employee?.nickname, employee?.rufname]
    .map(normalizeName)
    .filter(Boolean)
    .join(" ");
  return identity.includes("alexander krista") || identity.includes("alex krista");
}

Module._load = function taskDigestLoader(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  if (!wrapped && (request === "./kristine" || request.endsWith("/kristine")) && exported && typeof exported.registerKristine === "function") {
    wrapped = true;
    const originalRegister = exported.registerKristine;
    const { registerTaskDigest } = require("./task-digest");

    exported.registerKristine = function registerKristineWithTaskDigest(app, options = {}) {
      const chefPhone = normalizePhone(options.chefPhoneNumber || process.env.CHEF_PHONE || "");
      const originalReadEmployees = options.readEmployees;
      const patchedReadEmployees = typeof originalReadEmployees === "function"
        ? async function readEmployeesWithChefFallback() {
            const rows = await originalReadEmployees();
            if (!Array.isArray(rows) || !chefPhone) return rows;
            return rows.map(employee => {
              const hasPhone = normalizePhone(employee?.phone || employee?.mobile || employee?.whatsapp);
              if (hasPhone || !isAlexEmployee(employee)) return employee;
              return { ...employee, phone: chefPhone };
            });
          }
        : originalReadEmployees;

      const patchedOptions = { ...options, readEmployees: patchedReadEmployees };
      const result = originalRegister(app, patchedOptions);

      registerTaskDigest({
        dataDir: patchedOptions.dataDir,
        readEmployees: patchedReadEmployees,
        sendWhatsApp: patchedOptions.sendWhatsApp,
        chefPhone: options.chefPhoneNumber || process.env.CHEF_PHONE || "",
        phoneNumberId: patchedOptions.phoneNumberId,
        logger: console,
      }).catch(error => console.error("KRISTINE Aufgaben-08:30 Registrierung fehlgeschlagen:", error));

      return result;
    };
  }
  return exported;
};
