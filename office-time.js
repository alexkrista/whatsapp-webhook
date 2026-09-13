"use strict";

function isOfficeJobId(value) {
  return ["022", "up_022"].includes(String(value || "").trim().toLowerCase());
}

function isInternalJobId(value) {
  const id = String(value || "").trim().toLowerCase();
  return id.startsWith("_") || ["system", "kristine"].includes(id) || isOfficeJobId(id);
}

function normalizeOfficeTimeRow(row) {
  if (!row || typeof row !== "object") return row;
  const office = isOfficeJobId(row.jobId) || String(row.unproductiveCode || row.upCode || "") === "022";
  if (!office || !["start", "weiter", "work", "up"].includes(row.type)) return row;
  return { ...row, type: "up", activityMode: "unproductive", billingType: "unproductive", reason: "Büro", upCode: "022", unproductiveCode: "022" };
}

// Interpret old office bookings consistently without deleting time or changing timestamps.
function normalizeOfficeTimeData(value) {
  if (Array.isArray(value)) return value.map(normalizeOfficeTimeData);
  if (!value || typeof value !== "object") return value;
  const row = { ...value };
  for (const key of ["segments", "originalSegments", "history", "before", "after"]) {
    if (Array.isArray(row[key])) row[key] = normalizeOfficeTimeData(row[key]);
  }
  return normalizeOfficeTimeRow(row);
}

module.exports = { isOfficeJobId, isInternalJobId, normalizeOfficeTimeRow, normalizeOfficeTimeData };
