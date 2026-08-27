"use strict";

const fsp = require("fs/promises");

if (!fsp.__kristaAccessPeopleFixInstalled) {
  fsp.__kristaAccessPeopleFixInstalled = true;
  const originalReadFile = fsp.readFile.bind(fsp);

  function presence(value, name) {
    return {
      present: typeof value === "boolean" ? value : null,
      name,
    };
  }

  fsp.readFile = async function patchedReadFile(file, ...args) {
    const result = await originalReadFile(file, ...args);
    const filename = String(file || "").replace(/\\/g, "/");
    if (!filename.endsWith("/_kristine/access-local-status.json")) return result;

    const encodingArg = args[0];
    const encoding = typeof encodingArg === "string" ? encodingArg : encodingArg?.encoding;
    if (!encoding) return result;

    try {
      const row = JSON.parse(String(result || "{}"));
      const gantner = row?.gantner || {};
      row.people = {
        alex: presence(gantner.alex, "Alex"),
        bettina: presence(gantner.bettina, "Bettina"),
        dunja: presence(gantner.dunja, "Dunja"),
        ...(row.people || {}),
      };
      return JSON.stringify(row, null, 2);
    } catch {
      return result;
    }
  };

  console.log("KRISTINE Zutritt Live-Presence Fix aktiv");
}
