"use strict";

/**
 * Linie 2 · Mitarbeiter-Dokumente + Personalstammdaten dauerhaft speichern.
 *
 * server.js cleanEmployeeMaster() kennt nicht alle neueren Mitarbeiterfelder.
 * Diese Vorlade-Erweiterung hält deshalb Dokumente und zusätzliche Personalakte-
 * Felder in einer persistenten Sidecar-Datei und mischt sie beim GET wieder ein.
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

const PROFILE_FIELDS = [
  "socialSecurityNumber",
  "collectiveAgreementClassification",
  "employmentHistory",
  "personnelDocuments",
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
const MAX_PERSONNEL_DOCS = 60;
const MAX_HISTORY_ROWS = 80;

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

function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_HISTORY_ROWS).map((row) => {
    const source = row && typeof row === "object" ? row : {};
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(source.from || "")) ? String(source.from) : "";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(source.to || "")) ? String(source.to) : "";
    const kind = String(source.kind || source.type || "Beschäftigung").trim().slice(0, 120) || "Beschäftigung";
    const note = String(source.note || "").trim().slice(0, 300);
    const id = String(source.id || `${from}-${to}-${kind}`).trim().slice(0, 120);
    return { id, from, to, kind, note };
  }).filter((row) => row.from || row.to || row.kind || row.note);
}

function sanitizePersonnelDocuments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PERSONNEL_DOCS).map((row, index) => {
    const source = row && typeof row === "object" ? row : {};
    const document = sanitizeDocument(source.document || source.file || source);
    if (!document) return null;
    return {
      id: String(source.id || `doc-${Date.now()}-${index}`).trim().slice(0, 120),
      title: String(source.title || source.label || document.name || "Dokument").trim().slice(0, 180) || "Dokument",
      category: String(source.category || "Sonstiges").trim().slice(0, 120) || "Sonstiges",
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(source.date || "")) ? String(source.date) : "",
      note: String(source.note || "").trim().slice(0, 300),
      document,
    };
  }).filter(Boolean);
}

function profileFromBody(body) {
  const result = {};
  let touched = false;
  const source = body && typeof body === "object" ? body : {};

  for (const field of DOCUMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    touched = true;
    result[field] = sanitizeDocument(source[field]);
  }

  if (Object.prototype.hasOwnProperty.call(source, "socialSecurityNumber")) {
    touched = true;
    result.socialSecurityNumber = String(source.socialSecurityNumber || "").trim().slice(0, 64);
  }
  if (Object.prototype.hasOwnProperty.call(source, "collectiveAgreementClassification")) {
    touched = true;
    result.collectiveAgreementClassification = String(source.collectiveAgreementClassification || "").trim().slice(0, 180);
  }
  if (Object.prototype.hasOwnProperty.call(source, "employmentHistory")) {
    touched = true;
    result.employmentHistory = sanitizeHistory(source.employmentHistory);
  }
  if (Object.prototype.hasOwnProperty.call(source, "personnelDocuments")) {
    touched = true;
    result.personnelDocuments = sanitizePersonnelDocuments(source.personnelDocuments);
  }

  return touched ? result : null;
}

function mergeEmployeeProfile(employee, store) {
  if (!employee || typeof employee !== "object") return employee;
  const id = String(employee.id || "").trim();
  if (!id || !store[id]) return employee;
  return { ...employee, ...store[id] };
}

function saveProfile(employeeId, profile) {
  const id = String(employeeId || "").trim();
  if (!id || !profile) return;

  const store = readStore();
  const current = store[id] && typeof store[id] === "object" ? store[id] : {};
  const next = { ...current };

  for (const field of [...DOCUMENT_FIELDS, ...PROFILE_FIELDS]) {
    if (!Object.prototype.hasOwnProperty.call(profile, field)) continue;
    const value = profile[field];
    const emptyArray = Array.isArray(value) && value.length === 0;
    const emptyString = typeof value === "string" && !value;
    if (value == null || emptyArray || emptyString) delete next[field];
    else next[field] = value;
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
              employees: payload.employees.map((employee) => mergeEmployeeProfile(employee, store)),
            };
          }
        } catch (error) {
          console.error("Mitarbeiter-Personalakte konnte nicht geladen werden:", error?.message || error);
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
      const profile = profileFromBody(req.body);
      const originalJson = res.json.bind(res);

      res.json = (payload) => {
        try {
          if (payload?.ok && payload.employee?.id && profile) {
            const employeeId = String(payload.employee.id);
            saveProfile(employeeId, profile);
            const store = readStore();
            payload = {
              ...payload,
              employee: mergeEmployeeProfile(payload.employee, store),
            };
          }
        } catch (error) {
          console.error("Mitarbeiter-Personalakte konnte nicht gespeichert werden:", error?.message || error);
          return originalJson({
            ok: false,
            error: "Mitarbeiterdaten wurden gespeichert, aber die Personalakte konnte nicht dauerhaft gesichert werden.",
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

console.log("✅ Mitarbeiter-Dokument- und Personalaktenpersistenz aktiv");
