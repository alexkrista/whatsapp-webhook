"use strict";

// Rows are day totals repeated for each report position, not individual punches.
function groupRegieComparisonRows(rows = []) {
  const groups = new Map();
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  for (const row of rows) {
    const date = String(row.date || "").slice(0, 10);
    const identity = row.employeeId ? `id:${row.employeeId}` : `name:${String(row.name || "").trim().toLocaleLowerCase("de-AT")}`;
    const key = JSON.stringify([date, identity]);
    let group = groups.get(key);
    if (!group) {
      group = { ...row, date, stamped: finite(row.stamped), regie: null, numbers: new Set() };
      groups.set(key, group);
    } else if (Math.abs(group.stamped - finite(row.stamped)) > 0.000001) {
      throw new Error("Widersprüchliche Tagesstunden im Stundenabgleich");
    }
    if (row.regie !== null && row.regie !== undefined) {
      group.regie = (group.regie ?? 0) + finite(row.regie);
      if (row.number) group.numbers.add(String(row.number));
    }
  }
  return [...groups.values()].map(({ numbers, ...row }) => ({
    ...row,
    diff: row.regie === null ? null : row.regie - row.stamped,
    noReport: row.regie === null,
    number: row.regie === null ? "kein Bericht" : [...numbers].join(", ")
  }));
}
module.exports = { groupRegieComparisonRows };
