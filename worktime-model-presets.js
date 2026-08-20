"use strict";

// Kleine Start-Erweiterung für die zentralen Arbeitszeitmodelle.
// Der bestehende KRISTA-Produktionsplan bleibt unangetastet. Wir ergänzen nur
// fehlende Büromodelle, damit sie in der Mitarbeiterkarte sauber zugeordnet
// werden können. Konkrete Wochenzeiten werden bewusst nicht erfunden.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const MODEL_FILE = path.join(DATA_DIR, "_system", "worktime-models.json");

const OFFICE_MODELS = [
  {
    id: "office-bettina",
    name: "Bettina",
    active: true,
    systemProtected: false,
    officeModel: true,
    configured: false,
    automaticTime: false,
    description: "Eigenes Büromodell. Wochenzeiten werden nach der tatsächlichen Arbeitsregel von Bettina hinterlegt."
  },
  {
    id: "office-dunja",
    name: "Dunja",
    active: true,
    systemProtected: false,
    officeModel: true,
    configured: false,
    automaticTime: false,
    description: "Eigenes Büromodell. Keine automatische Zeit, bis die gewünschte Regel ausdrücklich festgelegt ist."
  },
  {
    id: "office-geri",
    name: "Geri",
    active: true,
    systemProtected: false,
    officeModel: true,
    configured: false,
    automaticTime: false,
    description: "Eigenes Büromodell. Die fixen Arbeitstage und Zeiten werden hier zentral hinterlegt."
  },
  {
    id: "office-judith",
    name: "Judith",
    active: true,
    systemProtected: false,
    officeModel: true,
    configured: false,
    automaticTime: false,
    description: "Eigenes Büromodell. Die tatsächlichen Arbeitstage werden zentral im Modell geführt."
  },
  {
    id: "office-alex",
    name: "Alex",
    active: true,
    systemProtected: false,
    officeModel: true,
    configured: true,
    automaticTime: true,
    automaticPayrollHours: 6.8,
    payrollReason: "Büro",
    projectTimeSource: "actual_stamps",
    description: "6,8 h tägliche Fink-Lohnzeit intern. Echte Baustellenstempel bleiben zusätzliche Projektzuordnung und dürfen die Finkzeit nicht doppeln."
  }
];

function mergeModels() {
  if (!fs.existsSync(MODEL_FILE)) return false;

  let models;
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));
    models = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Arbeitszeitmodelle konnten nicht gelesen werden:", error?.message || error);
    return false;
  }

  let changed = false;
  for (const preset of OFFICE_MODELS) {
    const existing = models.find((row) => String(row?.id || "") === preset.id);
    if (existing) continue;
    models.push({ ...preset });
    changed = true;
  }

  if (!changed) return true;

  try {
    fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
    fs.writeFileSync(MODEL_FILE, JSON.stringify(models, null, 2), "utf8");
    console.log("KRISTA Arbeitszeitmodelle ergänzt:", OFFICE_MODELS.map((row) => row.name).join(", "));
    return true;
  } catch (error) {
    console.error("Arbeitszeitmodelle konnten nicht ergänzt werden:", error?.message || error);
    return false;
  }
}

// Normalerweise existiert die Datei bereits. Falls ein frisches System zuerst
// den Server-Default anlegt, versuchen wir nach dem Start noch einige Male.
if (!mergeModels()) {
  [1000, 5000, 15000, 45000].forEach((delay) => {
    const timer = setTimeout(mergeModels, delay);
    timer.unref?.();
  });
}
