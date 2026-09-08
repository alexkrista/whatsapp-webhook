"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manager = fs.readFileSync(path.join(root, "krista_service_manager_bg.py"), "utf8");
const installer = fs.readFileSync(path.join(root, "krista_service_install.ps1"), "utf8");

assert.match(manager, /def _brain_watchdog\(\)/, "Dienstemanager besitzt einen Brain-Waechter");
assert.match(manager, /threading\.Thread\(target=_brain_watchdog/, "Brain-Waechter startet mit dem Dienstemanager");
assert.match(manager, /if not _brain_http_ok\(\):[\s\S]*?_start_brain\(\)/, "Offline-Brain wird automatisch gestartet");
assert.match(installer, /Kristine The Brain Dienst/, "Installer kennt den bestehenden Brain-Windows-Task");
assert.match(installer, /MSFT_TaskBootTrigger/, "Installer erkennt einen vorhandenen Start-Ausloeser");
assert.match(installer, /New-ScheduledTaskTrigger -AtStartup/, "Installer ergaenzt den Start beim Hochfahren");

console.log("OK: Brain Connector startet nach Windows-Neustarts automatisch und wird ueberwacht.");
