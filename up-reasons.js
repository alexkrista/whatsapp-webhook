"use strict";

// Bestehende Finkzeit-Arten; keine Änderung der Abrechnungsregeln.
const UP_REASONS = [["022","Büro"],["900","Urlaub"],["901","Krank"],["902","Arzt"],["903","Berufsschule"],["904","Feiertag"],["905","Schulung extern"],["909","Schulung intern"],["911","Sonderurlaub"],["912","Musterung"],["913","Werkstatt"],["917","Firma aufräumen"],["918","Lehrlingswettbewerb"],["927","Betriebsausflug"],["930","Zeitausgleich"],["945","Quarantäne"],["946","Kurzarbeit"],["9999","Sanierung"]];
function upJob(code) {
  const row = UP_REASONS.find(([id]) => id === String(code || ""));
  return row ? { jobId: `up_${row[0]}`, jobName: row[1], status: "UP", upCode: row[0], reason: row[1], city: "", address: "" } : null;
}
function upFromJobId(id) { return upJob(String(id || "").startsWith("up_") ? String(id).slice(3) : ""); }
module.exports = { UP_REASONS, upJob, upFromJobId };

