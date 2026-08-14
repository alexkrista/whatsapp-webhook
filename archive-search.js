// archive-search.js
// Kristine Archivsuche – SQL + PDF-Archiv

const ARCHIVE_CONNECTOR =
  process.env.ARCHIVE_CONNECTOR ||
  "http://127.0.0.1:5051";

async function searchArchiveConnector(q) {
  const url = `${ARCHIVE_CONNECTOR}/search?q=${encodeURIComponent(q)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Archiv-Connector HTTP ${response.status}`);
  }
  return data;
}

async function openArchiveConnector(path) {
  const response = await fetch(`${ARCHIVE_CONNECTOR}/open`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Archiv-Connector HTTP ${response.status}`);
  }
  return data;
}

async function loadArchiveThumbnail(path) {
  const url = `${ARCHIVE_CONNECTOR}/thumb?path=${encodeURIComponent(path)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "image/png" }
  });

  if (!response.ok) throw new Error(`Thumbnail HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || "image/png"
  };
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function deDate(value) {
  if (!value) return "–";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(value);
}

function groupDocuments(documents) {
  const byYear = new Map();
  for (const d of documents) {
    const year = String(d.year || "Ohne Jahr");
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(d);
  }

  return [...byYear.entries()].sort((a, b) => {
    if (a[0] === "Ohne Jahr") return 1;
    if (b[0] === "Ohne Jahr") return -1;
    return Number(b[0]) - Number(a[0]);
  });
}

function countDocumentTypes(documents) {
  const counts = new Map();
  for (const d of documents) {
    const type = String(d.dokumenttyp || "Dokument").trim() || "Dokument";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function registerArchiveSearch(app) {

  app.get("/archiv", async (req, res) => {
    const q = String(req.query.q || "").trim();

    let projects = [];
    let documents = [];
    let sqlError = "";
    let connectorError = "";

    if (q) {
      try {
        const data = await searchArchiveConnector(q);
        projects = Array.isArray(data.projects) ? data.projects : [];
        documents = Array.isArray(data.documents) ? data.documents : [];
        sqlError = String(data.sqlError || "");
      } catch (err) {
        connectorError = String(err?.message || err);
        console.error("Archiv-Connector:", err);
      }
    }

    const years = groupDocuments(documents);
    const typeCounts = countDocumentTypes(documents);

    const html = `
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kristine · Archiv</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f6f8;
  color: #202124;
}
.header { background:#20242a; color:white; padding:22px 32px; }
.header-inner { max-width:1380px; margin:auto; display:flex; justify-content:space-between; align-items:center; }
.brand { font-size:24px; font-weight:750; }
.subtitle { color:#adb5bd; font-size:13px; margin-top:3px; }
.status { color:#b8c0c8; font-size:13px; }
.container { max-width:1380px; margin:30px auto; padding:0 20px 70px; }
.search-box {
  background:white; padding:20px; border-radius:12px;
  box-shadow:0 2px 5px rgba(0,0,0,.05),0 8px 25px rgba(0,0,0,.04);
}
.search-row { display:flex; gap:10px; }
.search-input { flex:1; border:1px solid #cfd4da; border-radius:9px; padding:16px 18px; font-size:20px; outline:none; }
.search-input:focus { border-color:#667788; box-shadow:0 0 0 3px rgba(80,100,120,.10); }
.search-button { border:0; border-radius:9px; padding:0 28px; background:#20242a; color:white; font-size:16px; font-weight:650; cursor:pointer; }
.examples { margin-top:11px; color:#777; font-size:13px; }
.alert { margin-top:16px; padding:12px 14px; border-radius:8px; font-size:13px; }
.alert.error { background:#fff4f4; border:1px solid #efc6c6; color:#8a2f2f; }
.alert.warn { background:#fff9e8; border:1px solid #eadba2; color:#705c15; }

.project-section { margin-top:22px; }
.project-card {
  background:white; border:1px solid #dde2e7; border-radius:13px; padding:20px 22px;
  box-shadow:0 3px 14px rgba(0,0,0,.045); margin-bottom:12px;
}
.project-card.primary { border-color:#aeb9c3; }
.project-top { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; }
.project-number { font-size:27px; font-weight:800; letter-spacing:-.4px; }
.project-title { font-size:17px; font-weight:650; margin-top:3px; }
.project-customer { margin-top:11px; font-size:15px; }
.project-address { color:#555; margin-top:4px; }
.project-dates { display:flex; gap:22px; flex-wrap:wrap; color:#555; font-size:14px; }
.date-box { background:#f6f7f8; border-radius:8px; padding:9px 12px; min-width:130px; }
.date-label { display:block; color:#8a8f95; font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
.more-projects { margin-top:7px; color:#777; font-size:13px; }

.doc-summary { margin:26px 0 18px; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.summary-title { font-weight:750; margin-right:5px; }
.type-chip { background:white; border:1px solid #dce1e5; border-radius:999px; padding:7px 11px; font-size:13px; }
.type-chip strong { margin-left:5px; }

.year-section { margin-top:28px; }
.year-heading { display:flex; align-items:baseline; gap:10px; margin:0 0 13px 2px; }
.year-number { font-size:24px; font-weight:800; }
.year-count { color:#888; font-size:13px; }
.doc-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
.doc-card {
  background:white; border:1px solid #e0e4e8; border-radius:12px; overflow:hidden;
  cursor:pointer; transition:transform .08s ease,box-shadow .08s ease,border-color .08s ease;
}
.doc-card:hover { transform:translateY(-2px); border-color:#b8c1c9; box-shadow:0 8px 20px rgba(0,0,0,.08); }
.doc-preview { width:100%; height:390px; background:#eef0f2; overflow:hidden; display:flex; align-items:flex-start; justify-content:center; }
.doc-preview img { width:100%; height:100%; object-fit:contain; background:white; }
.doc-info { padding:13px 14px 15px; }
.doc-line { display:flex; justify-content:space-between; gap:10px; align-items:center; }
.doc-type { display:inline-block; background:#edf0f2; color:#555; border-radius:5px; padding:4px 8px; font-size:12px; font-weight:700; }
.doc-date { color:#7c8288; font-size:12px; white-space:nowrap; }
.doc-name { margin-top:8px; font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.open-button { margin-top:11px; border:0; border-radius:6px; padding:8px 12px; background:#343a40; color:white; cursor:pointer; }
.empty { margin-top:25px; background:white; border:1px dashed #ccd1d6; border-radius:10px; padding:35px 20px; text-align:center; color:#777; }

@media (max-width:1000px) { .doc-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:700px) {
  .search-row { flex-direction:column; }
  .search-button { height:52px; }
  .project-top { flex-direction:column; }
  .doc-grid { grid-template-columns:1fr; }
  .doc-preview { height:420px; }
}
</style>
</head>
<body>
<div class="header"><div class="header-inner">
  <div><div class="brand">Kristine · Archiv</div><div class="subtitle">WinWorker SQL + Dokumentenarchiv</div></div>
  <div class="status">Archivsuche V0.5</div>
</div></div>

<div class="container">
<form method="get" action="/archiv" class="search-box">
  <div class="search-row">
    <input class="search-input" name="q" autofocus autocomplete="off"
      placeholder="Projekt, Kunde, Rechnung, Adresse, Text ..." value="${esc(q)}">
    <button class="search-button">Suchen</button>
  </div>
  <div class="examples">Beispiele: 6844 Fusonic · 202205010 · 26085 · Innenmalerarbeiten</div>
</form>

${connectorError ? `<div class="alert error">Connector: ${esc(connectorError)}</div>` : ""}
${sqlError ? `<div class="alert warn">PDF-Suche funktioniert. SQL: ${esc(sqlError)}</div>` : ""}

${q && projects.length ? `
<div class="project-section">
  ${projects.slice(0, 5).map((p, i) => `
    <div class="project-card ${i === 0 ? "primary" : ""}">
      <div class="project-top">
        <div>
          <div class="project-number">Projekt ${esc(p.projectNumber)}</div>
          <div class="project-title">${esc(p.title || p.site || "")}</div>
          <div class="project-customer">${esc(p.company || p.customer || "")}</div>
          <div class="project-address">${esc(p.address || "")}</div>
        </div>
        <div class="project-dates">
          <div class="date-box"><span class="date-label">Erstes Datum</span>${deDate(p.firstDate)}</div>
          <div class="date-box"><span class="date-label">Letztes Datum</span>${deDate(p.lastDate)}</div>
        </div>
      </div>
    </div>
  `).join("")}
  ${projects.length > 5 ? `<div class="more-projects">+ ${projects.length - 5} weitere SQL-Treffer</div>` : ""}
</div>` : ""}

${q && documents.length ? `
<div class="doc-summary">
  <span class="summary-title">${documents.length} Dokumente</span>
  ${typeCounts.map(([type,count]) => `<span class="type-chip">${esc(type)} <strong>${count}</strong></span>`).join("")}
</div>

${years.map(([year, docs]) => `
<section class="year-section">
  <div class="year-heading"><div class="year-number">${esc(year)}</div><div class="year-count">${docs.length} Dokumente · letzter Druck zuerst</div></div>
  <div class="doc-grid">
    ${docs.map(d => `
      <article class="doc-card" data-path="${esc(d.path)}" onclick="openArchivePdf(this.dataset.path)">
        <div class="doc-preview">
          <img loading="lazy" src="/api/archive/thumb?path=${encodeURIComponent(d.path)}"
               alt="Vorschau ${esc(d.filename)}" onerror="this.style.display='none'">
        </div>
        <div class="doc-info">
          <div class="doc-line">
            <span class="doc-type">${esc(d.dokumenttyp || "Dokument")}</span>
            <span class="doc-date">${deDate(d.printDate)}</span>
          </div>
          <div class="doc-name" title="${esc(d.filename)}">${esc(d.filename)}</div>
          <button class="open-button" type="button" data-path="${esc(d.path)}"
            onclick="event.stopPropagation(); openArchivePdf(this.dataset.path)">Öffnen</button>
        </div>
      </article>
    `).join("")}
  </div>
</section>
`).join("")}
` : q ? `<div class="empty">Keine passenden Dokumente gefunden.</div>` : `<div class="empty">Suche im Kristine-Archiv</div>`}
</div>

<script>
async function openArchivePdf(path) {
  try {
    const response = await fetch("/api/archive/open", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({path})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) alert(data.error || "PDF konnte nicht geöffnet werden.");
  } catch (err) {
    alert("Archiv-Connector nicht erreichbar.");
  }
}
</script>
</body>
</html>`;

    res.status(200).type("html").send(html);
  });

  app.post("/api/archive/open", async (req, res) => {
    try {
      const pdfPath = String(req.body?.path || "").trim();
      if (!pdfPath) return res.status(400).json({ ok:false, error:"PDF-Pfad fehlt" });
      const result = await openArchiveConnector(pdfPath);
      return res.json(result);
    } catch (err) {
      console.error("Archiv PDF öffnen:", err);
      return res.status(502).json({ ok:false, error:String(err?.message || err) });
    }
  });

  app.get("/api/archive/thumb", async (req, res) => {
    try {
      const pdfPath = String(req.query.path || "").trim();
      if (!pdfPath) return res.status(400).send("PDF-Pfad fehlt");
      const thumb = await loadArchiveThumbnail(pdfPath);
      res.setHeader("Content-Type", thumb.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.send(thumb.buffer);
    } catch (err) {
      console.error("Archiv Thumbnail:", err);
      return res.status(404).end();
    }
  });

  app.get("/api/archive/status", (req, res) => {
    res.json({
      ok:true,
      module:"archive-search",
      version:"0.5",
      connector:ARCHIVE_CONNECTOR
    });
  });
}

module.exports = { registerArchiveSearch };
