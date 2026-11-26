"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const XLSX = require("xlsx");

const label = value => String(value ?? "").trim().slice(0, 500);
const money = value => Math.round(Number(value) * 100);
const date = value => {
  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) value = [d.y, d.m, d.d].map(n => String(n).padStart(2, "0")).join("-");
  }
  const iso = String(value ?? "").slice(0, 10);
  const parsed = new Date(iso + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(+parsed) && parsed.toISOString().startsWith(iso) ? iso : "";
};

function importWorkbook(bytes) {
  const workbook = XLSX.read(bytes, {type:"buffer", sheetRows:1000});
  const summary = workbook.Sheets["Hafbrief Ablauf Übersicht"];
  if (!summary || !workbook.SheetNames.some(name => /^Ablauf (?:\d{4}|unbegrenzt)$/.test(name))) {
    throw new Error("Die Tabellenblätter der SPK-Haftungsübersicht fehlen.");
  }
  const rows = [];
  for (const name of workbook.SheetNames.filter(name => /^Ablauf (?:\d{4}|unbegrenzt)$/.test(name))) {
    const lines = XLSX.utils.sheet_to_json(workbook.Sheets[name], {header:1,raw:true});
    let previous;
    for (const [index, [issued, recipient, current, expiry, historical, oldExpiry, extra]] of lines.slice(1).entries()) {
      if (!date(issued) || !label(recipient)) {
        if (!recipient && typeof oldExpiry === "string" && previous) previous.note += " " + label(oldExpiry);
        continue;
      }
      const amount = money(current ?? historical);
      if (!Number.isSafeInteger(amount) || amount <= 0) continue;
      const note = [typeof oldExpiry === "string" && !date(oldExpiry) ? oldExpiry : "", extra].map(label).filter(Boolean).join(" ");
      const chf = note.match(/CHF\s+([\d.'’]+)(?!\d)/i);
      previous = {
        id:randomUUID(), bank:"Sparkasse", recipient:label(recipient), project:"",
        issued:date(issued), expiry:date(expiry ?? oldExpiry), currency:chf ? "CHF" : "EUR",
        amount:chf ? money(chf[1].replace(/[.'’]/g,"")) : amount, eur:amount,
        type:"guarantee", status:current == null ? "historical" : "active",
        note, source:name + ":" + (index+2),
      };
      rows.push(previous);
    }
  }
  for (const row of rows) {
    if (/zurückbehalten|erhalten.*nach Ablauf/i.test(row.note)) {
      row.type = "retention";
      row.bank = "";
    }
  }
  if (!rows.length) throw new Error("Die Datei enthält keine importierbaren Haftungen.");
  const limit = money(summary.B14?.v);
  return {banks:Number.isSafeInteger(limit) && limit > 0 ? [{name:"Sparkasse",limit}] : [], rows};
}

function normalize(body) {
  if (!Array.isArray(body?.rows) || !Array.isArray(body?.banks) || body.rows.length > 5000 || body.banks.length > 100) {
    throw new Error("Ungültige Haftungsdaten.");
  }
  const cents = (value, min) => {
    if (!Number.isSafeInteger(value) || value < min || value > 100_000_000_000) throw new Error("Ungültiger Betrag.");
    return value;
  };
  const banks = body.banks.map(bank => ({name:label(bank.name),limit:cents(bank.limit,0)}));
  const names = new Set(banks.map(bank => bank.name));
  if (names.has("") || names.size !== banks.length) throw new Error("Banknamen müssen eindeutig sein.");
  const ids = new Set();
  const rows = body.rows.map(row => {
    if (!label(row.recipient) || !["guarantee","retention"].includes(row.type) ||
        !["active","released","historical"].includes(row.status) || !["EUR","CHF"].includes(row.currency) ||
        (row.issued && !date(row.issued)) || (row.expiry && !date(row.expiry))) {
      throw new Error("Bitte Empfänger, Typ, Status, Währung und Datum prüfen.");
    }
    const id = label(row.id) || randomUUID();
    if (ids.has(id)) throw new Error("Doppelter Eintrag.");
    ids.add(id);
    const amount = cents(row.amount,1);
    return {id,recipient:label(row.recipient),project:label(row.project),bank:label(row.bank),issued:date(row.issued),
      expiry:date(row.expiry),type:row.type,status:row.status,currency:row.currency,amount,
      eur:row.currency==="EUR" ? amount : cents(row.eur,1),note:label(row.note),source:label(row.source)};
  });
  return {banks,rows};
}

function register(app,{dataDir,requireAdmin}) {
  const file = path.join(dataDir,"_system","krisadmin-guarantees.json");
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file,"utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; return {revision:0,banks:[],rows:[]}; }
  };
  function requireFinance(req,res) {
    if (!requireAdmin(req,res)) return false;
    if (req.kristineActor && !req.kristineActor.permissions?.financeApproval) {
      res.status(403).json({error:"Für diesen Benutzer nicht freigegeben."});
      return false;
    }
    return true;
  }
  app.get("/admin/haftungen",(req,res) => {
    if (!requireFinance(req,res)) return;
    res.set("Referrer-Policy","no-referrer").sendFile(path.join(__dirname,"public","admin-guarantees.html"));
  });
  app.get("/admin/api/haftungen",(req,res) => {
    if (!requireFinance(req,res)) return;
    res.set("Cache-Control","no-store").json(read());
  });
  app.post("/admin/api/haftungen/import",(req,res) => {
    if (!requireFinance(req,res)) return;
    const input = req.body?.xlsx;
    if (typeof input !== "string" || input.length > 3_000_000 || !input.startsWith("UEs")) {
      return res.status(400).json({error:"Bitte eine XLSX-Datei bis 2 MB auswählen."});
    }
    try { res.json(importWorkbook(Buffer.from(input,"base64"))); }
    catch (error) { res.status(400).json({error:error.message}); }
  });
  app.put("/admin/api/haftungen",(req,res) => {
    if (!requireFinance(req,res)) return;
    let data;
    try { data = normalize(req.body); }
    catch (error) { return res.status(400).json({error:error.message}); }
    const current = read();
    if (req.body.revision !== current.revision) return res.status(409).json({error:"Die Liste wurde inzwischen geändert. Bitte neu laden."});
    const saved = {...data,revision:current.revision+1};
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp = file + "." + randomUUID();
    try {
      fs.writeFileSync(temp,JSON.stringify(saved),{mode:0o600});
      fs.renameSync(temp,file);
    } finally { fs.rmSync(temp,{force:true}); }
    res.json(saved);
  });
}

module.exports = {register, importWorkbook, normalize};
