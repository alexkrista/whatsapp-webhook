"use strict";

// Persistiert ausschliesslich bestaetigte Uebergaben von Musteretiketten an
// die lokale Zebra-Bridge. Vorherige, nicht protokollierte Drucke sind nicht
// rekonstruierbar. Die Daten bleiben serverseitig fuer alle Admin-Arbeitsplaetze.
const fs = require("node:fs/promises");
const path = require("node:path");

function registerPaintSampleLabelHistory(app, options = {}) {
  const root = path.join(options.dataDir || process.env.DATA_DIR || "/var/data", "_kristine", "paint");
  const file = path.join(root, "sample-label-history.json");
  const {requireAdmin} = require("./admin-auth");
  const MAX_SAVED = 5000;
  let queue = Promise.resolve();

  function serial(fn) {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  }
  async function read() {
    try {
      const rows = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(rows)) throw Error("Etiketten-Historie ist ungueltig");
      return rows;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error; // Niemals eine defekte Datei still ueberschreiben.
    }
  }
  async function write(rows) {
    await fs.mkdir(root, {recursive:true});
    const temp = file + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(rows, null, 2), {encoding:"utf8", mode:0o600});
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, {force:true}).catch(() => {});
      throw error;
    }
  }
  function printText(raw, field, width) {
    if (typeof raw !== "string") throw Error(field + " fehlt");
    const value = raw.trim().replace(/[ \t]+/g, " ");
    if (!value || value.length > 70 || /[\r\n\^~]/.test(value)) throw Error(field + ": ungueltiger Drucktext");
    const ascii = value.replace(/Ä/g,"Ae").replace(/Ö/g,"Oe").replace(/Ü/g,"Ue")
      .replace(/ä/g,"ae").replace(/ö/g,"oe").replace(/ü/g,"ue").replace(/ß/g,"ss")
      .replace(/[^A-Za-z0-9 .:/_-]/g,"").trim();
    if (!ascii) throw Error(field + " fehlt");
    let lines = 1, current = "";
    for (const word of ascii.split(/\s+/)) {
      if (word.length > width) throw Error(field + ": Wort zu lang");
      const joined = current ? current + " " + word : word;
      if (joined.length <= width) current = joined;
      else { lines++; current = word; }
      if (lines > 2) throw Error(field + ": maximal zwei Zeilen");
    }
    return value;
  }

  app.get("/admin/api/paint/sample-label-history", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    try {
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query?.limit,10) || 20));
      const offset = Math.min(MAX_SAVED, Math.max(0, Number.parseInt(req.query?.offset,10) || 0));
      const q = String(req.query?.q || "").trim().toLocaleLowerCase("de").slice(0,120);
      const rows = await read();
      const filtered = !q ? rows : rows.filter(row =>
        [row.colour,row.material,row.reference,row.printedBy].some(v =>
          String(v || "").toLocaleLowerCase("de").includes(q)));
      res.set("Cache-Control","no-store");
      res.json({ok:true,items:filtered.slice(offset,offset+limit),count:filtered.length,total:rows.length,offset,limit});
    } catch (error) {
      res.status(500).json({ok:false,error:"Musteretiketten-Historie konnte nicht gelesen werden: "+error.message});
    }
  });

  app.post("/admin/api/paint/sample-label-history", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    try {
      const input=req.body || {};
      const id=String(input.id || "");
      if (!/^sample_[A-Za-z0-9_-]{8,100}$/.test(id)) {
        return res.status(400).json({ok:false,error:"Druckvorgang-ID ungueltig"});
      }
      const colour=printText(input.colour,"Farbe",18);
      const material=printText(input.material,"Material",28);
      const reference=String(input.reference || "").trim().replace(/\s+/g," ").slice(0,50);
      if (/[\r\n\^~]/.test(reference)) {
        return res.status(400).json({ok:false,error:"Referenznummer ungueltig"});
      }
      const {item,existing}=await serial(async () => {
        const rows=await read();
        const previous=rows.find(row=>row.id===id);
        if (previous) {
          if (previous.colour!==colour || previous.material!==material || previous.reference!==reference)
            return {conflict:true};
          return {item:previous,existing:true};
        }
        const item={
          id,kind:"sample",colour,material,reference,
          printedAt:new Date().toISOString(),
          printedBy:String(req.kristineActor?.name || req.headers?.["x-krista-user-name"] || "").slice(0,100),
        };
        rows.unshift(item);
        if (rows.length>MAX_SAVED) rows.length=MAX_SAVED;
        await write(rows);
        return {item,existing:false};
      });
      if (!item) return res.status(409).json({ok:false,error:"Druckvorgang-ID bereits mit anderem Inhalt gespeichert"});
      res.json({ok:true,item,existing});
    } catch (error) {
      if (/^(Farbe|Material)/.test(String(error.message||"")))
        return res.status(400).json({ok:false,error:error.message});
      res.status(500).json({ok:false,error:"Musteretiketten-Historie konnte nicht gespeichert werden: "+error.message});
    }
  });
}

module.exports = {registerPaintSampleLabelHistory};
