"use strict";

/**
 * Linie 2 · Mitarbeiter-Dokumente dauerhaft speichern.
 *
 * Hintergrund:
 * public/admin.html sendet Führerschein-/Pass-Dateien als ...Document-Objekte.
 * server.js cleanEmployeeMaster() kennt aktuell nur die alten ...Image-Felder und
 * verwirft PDF/DOC/DOCX beim Speichern. Diese kleine Vorlade-Erweiterung hält die
 * vier Dokumentobjekte deshalb in einer separaten persistenten Sidecar-Datei und
 * mischt sie beim GET /admin/api/employees wieder in die Mitarbeiter ein.
 *
 * server.js bleibt damit unangetastet; alte Bildfelder funktionieren weiter.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const STORE_FILE = path.join(DATA_DIR, "_system", "employee-documents.json");

const DOCUMENT_FIELDS = [
  "drivingLicenseFrontDocument",
  "drivingLicenseBackDocument",
  "passportPage1Document",
  "passportPage2Document",
];

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MAX_DATA_CHARS = 8_000_000;

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  ensureStoreDir();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function sanitizeDocument(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const name = String(value.name || "Dokument").trim().slice(0, 180) || "Dokument";
  const type = String(value.type || "").trim().toLowerCase().slice(0, 160);
  const data = String(value.data || "");
  const size = Math.max(0, Number(value.size || 0));

  if (!ALLOWED_TYPES.has(type)) return null;
  if (!data || data.length > MAX_DATA_CHARS) return null;

  const expectedPrefix = `data:${type};base64,`;
  if (!data.toLowerCase().startsWith(expectedPrefix.toLowerCase())) return null;

  return {
    name,
    type,
    size: Number.isFinite(size) ? size : 0,
    data,
  };
}

function docsFromBody(body) {
  const result = {};
  let touched = false;
  const source = body && typeof body === "object" ? body : {};

  for (const field of DOCUMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    touched = true;
    result[field] = sanitizeDocument(source[field]);
  }

  return touched ? result : null;
}

function mergeEmployeeDocs(employee, store) {
  if (!employee || typeof employee !== "object") return employee;
  const id = String(employee.id || "").trim();
  if (!id || !store[id]) return employee;
  return { ...employee, ...store[id] };
}

function saveDocs(employeeId, docs) {
  const id = String(employeeId || "").trim();
  if (!id || !docs) return;

  const store = readStore();
  const current = store[id] && typeof store[id] === "object" ? store[id] : {};
  const next = { ...current };

  for (const field of DOCUMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(docs, field)) continue;
    if (docs[field]) next[field] = docs[field];
    else delete next[field];
  }

  if (Object.keys(next).length) store[id] = next;
  else delete store[id];
  writeStore(store);
}

function installEmployeeGetInterceptor() {
  const originalGet = express.application.get;
  express.application.get = function patchedGet(route, ...handlers) {
    if (route !== "/admin/api/employees" || handlers.length === 0) {
      return originalGet.call(this, route, ...handlers);
    }

    const mergeMiddleware = (req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = (payload) => {
        try {
          if (payload?.ok && Array.isArray(payload.employees)) {
            const store = readStore();
            payload = {
              ...payload,
              employees: payload.employees.map((employee) => mergeEmployeeDocs(employee, store)),
            };
          }
        } catch (error) {
          console.error("Mitarbeiter-Dokumente konnten nicht geladen werden:", error?.message || error);
        }
        return originalJson(payload);
      };
      next();
    };

    return originalGet.call(this, route, mergeMiddleware, ...handlers);
  };
}

function installEmployeeWriteInterceptor(methodName, route) {
  const original = express.application[methodName];
  express.application[methodName] = function patchedWrite(registeredRoute, ...handlers) {
    if (registeredRoute !== route) {
      return original.call(this, registeredRoute, ...handlers);
    }

    const persistenceMiddleware = (req, res, next) => {
      const docs = docsFromBody(req.body);
      const originalJson = res.json.bind(res);

      res.json = (payload) => {
        try {
          if (payload?.ok && payload.employee?.id && docs) {
            const employeeId = String(payload.employee.id);
            saveDocs(employeeId, docs);
            const store = readStore();
            payload = {
              ...payload,
              employee: mergeEmployeeDocs(payload.employee, store),
            };
          }
        } catch (error) {
          console.error("Mitarbeiter-Dokumente konnten nicht gespeichert werden:", error?.message || error);
          return originalJson({
            ok: false,
            error: "Mitarbeiterdaten wurden gespeichert, aber das Dokument konnte nicht dauerhaft gesichert werden.",
          });
        }
        return originalJson(payload);
      };

      next();
    };

    return original.call(this, registeredRoute, persistenceMiddleware, ...handlers);
  };
}

installEmployeeGetInterceptor();
installEmployeeWriteInterceptor("post", "/admin/api/employees");
installEmployeeWriteInterceptor("put", "/admin/api/employees/:employeeId");

console.log("✅ Mitarbeiter-Dokumentpersistenz aktiv");
