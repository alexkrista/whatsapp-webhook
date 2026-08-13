// archive-search.js
// Kristine Archivsuche – Browser-Oberfläche
// Datenquellen später: lokaler Connector -> WinWorker SQL + PDF-Index

const ARCHIVE_CONNECTOR =
  process.env.ARCHIVE_CONNECTOR ||
  "http://127.0.0.1:5051";

async function searchArchiveConnector(q) {
  const url =
    `${ARCHIVE_CONNECTOR}/search?q=${encodeURIComponent(q)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Archiv-Connector HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!data?.ok) {
    throw new Error(
      data?.error || "Archiv-Connector meldet Fehler"
    );
  }

  return Array.isArray(data.documents)
    ? data.documents
    : [];
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
  const url =
    `${ARCHIVE_CONNECTOR}/thumb?path=${encodeURIComponent(path)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "image/png"
    }
  });

  if (!response.ok) {
    throw new Error(`Thumbnail HTTP ${response.status}`);
  }

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

function registerArchiveSearch(app) {

  // ============================================================
  // Browser-Maske
  // ============================================================

  app.get("/archiv", async (req, res) => {

    const q = String(req.query.q || "").trim();

    // Später kommen diese Daten vom lokalen Kristine-Connector.
    // Projekte kommen im nächsten Schritt aus dem lokalen SQL-Connector.
 const projects = [];
let documents = [];
let connectorError = "";

if (q) {
  try {
    documents = await searchArchiveConnector(q);
  } catch (err) {
    connectorError = String(err?.message || err);
    console.error("Archiv-Connector:", err);
  }
}

    const html = `
<!doctype html>
<html lang="de">
<head>

<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Kristine · Archiv</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background: #f5f6f8;
  color: #202124;
}

/* ------------------------------------------------------------
   HEADER
------------------------------------------------------------ */

.header {
  background: #20242a;
  color: white;
  padding: 22px 32px;
}

.header-inner {
  max-width: 1250px;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.brand {
  font-size: 24px;
  font-weight: 700;
}

.subtitle {
  color: #adb5bd;
  font-size: 13px;
  margin-top: 3px;
}

.status {
  font-size: 13px;
  color: #b8c0c8;
}

/* ------------------------------------------------------------
   CONTENT
------------------------------------------------------------ */

.container {
  max-width: 1250px;
  margin: 34px auto;
  padding: 0 20px 60px;
}

/* ------------------------------------------------------------
   SEARCH
------------------------------------------------------------ */

.search-box {
  background: white;
  padding: 22px;
  border-radius: 12px;

  box-shadow:
    0 2px 5px rgba(0,0,0,.05),
    0 8px 25px rgba(0,0,0,.04);
}

.search-row {
  display: flex;
  gap: 10px;
}

.search-input {
  flex: 1;

  border: 1px solid #cfd4da;
  border-radius: 9px;

  padding: 16px 18px;

  font-size: 20px;
  outline: none;
}

.search-input:focus {
  border-color: #667788;
  box-shadow: 0 0 0 3px rgba(80,100,120,.10);
}

.search-button {
  border: 0;
  border-radius: 9px;

  padding: 0 26px;

  background: #20242a;
  color: white;

  font-size: 16px;
  font-weight: 600;

  cursor: pointer;
}

.search-button:hover {
  background: #343a40;
}

.examples {
  margin-top: 12px;
  color: #777;
  font-size: 13px;
}

/* ------------------------------------------------------------
   SOURCE CARDS
------------------------------------------------------------ */

.sources {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 15px;
  margin-top: 20px;
}

.source {
  background: white;
  border-radius: 10px;
  padding: 17px 20px;
  border: 1px solid #e2e5e9;
}

.source-title {
  font-weight: 700;
}

.source-text {
  color: #777;
  font-size: 13px;
  margin-top: 5px;
}

.source-state {
  display: inline-block;
  margin-top: 9px;
  padding: 4px 8px;

  border-radius: 5px;
  background: #f0f1f3;

  color: #666;
  font-size: 12px;
}

/* ------------------------------------------------------------
   RESULTS
------------------------------------------------------------ */

.section {
  margin-top: 34px;
}

.section-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 13px;
}

.section-title {
  font-size: 20px;
  font-weight: 700;
}

.result-count {
  color: #888;
  font-size: 13px;
}

.card {
  background: white;

  border: 1px solid #e2e5e9;
  border-radius: 10px;

  padding: 18px 20px;
  margin-bottom: 10px;
}

.project-number {
  font-size: 18px;
  font-weight: 700;
}

.customer {
  margin-top: 6px;
}

.meta {
  margin-top: 7px;
  color: #777;
  font-size: 13px;
}

.doc-type {
  display: inline-block;

  background: #edf0f2;
  color: #555;

  border-radius: 5px;

  padding: 4px 8px;
  margin-right: 8px;

  font-size: 12px;
  font-weight: 600;
}

.doc-name {
  font-weight: 650;
}

.doc-path {
  margin-top: 8px;

  color: #777;
  font-size: 12px;

  word-break: break-all;
}

.open-button {
  display: inline-block;

  margin-top: 12px;
  padding: 8px 13px;

  border: 0;
  border-radius: 6px;

  background: #343a40;
  color: white;

  cursor: pointer;
}

.doc-card {
  cursor: pointer;
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
  transition:
    transform .08s ease,
    box-shadow .08s ease,
    border-color .08s ease;
}

.doc-card:hover {
  transform: translateY(-1px);
  border-color: #bcc3ca;
  box-shadow: 0 5px 15px rgba(0,0,0,.07);
}

.doc-preview {
  width: 150px;
  min-height: 195px;
  border: 1px solid #e2e5e9;
  border-radius: 7px;
  overflow: hidden;
  background: #f2f3f5;
  display: flex;
  align-items: center;
  justify-content: center;
}

.doc-preview img {
  display: block;
  width: 100%;
  height: auto;
}

.doc-main {
  min-width: 0;
}

.doc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
}

.doc-snippet {
  margin-top: 12px;
  padding: 11px 13px;
  background: #f7f8fa;
  border-radius: 7px;
  color: #444;
  font-size: 14px;
  line-height: 1.45;
}

.connector-error {
  margin-top: 18px;
  padding: 12px 14px;
  background: #fff4f4;
  border: 1px solid #f1c5c5;
  border-radius: 8px;
  color: #8a2f2f;
  font-size: 13px;
}

/* ------------------------------------------------------------
   EMPTY
------------------------------------------------------------ */

.empty {
  background: white;
  border: 1px dashed #ccd1d6;
  border-radius: 10px;

  padding: 35px 20px;

  text-align: center;
  color: #777;
}

.hint {
  margin-top: 8px;
  font-size: 13px;
  color: #999;
}

/* ------------------------------------------------------------
   MOBILE
------------------------------------------------------------ */

@media (max-width: 700px) {

  .search-row {
    flex-direction: column;
  }

  .search-button {
    height: 52px;
  }

  .sources {
    grid-template-columns: 1fr;
  }

  .doc-card {
    grid-template-columns: 1fr;
  }

  .doc-preview {
    width: 110px;
    min-height: 140px;
  }

}

</style>

</head>

<body>

<div class="header">

  <div class="header-inner">

    <div>
      <div class="brand">Kristine · Archiv</div>
      <div class="subtitle">
        WinWorker + Dokumentenarchiv
      </div>
    </div>

    <div class="status">
      Archivsuche V0.2
    </div>

  </div>

</div>


<div class="container">

  <form method="get" action="/archiv" class="search-box">

    <div class="search-row">

      <input
        class="search-input"
        name="q"
        autofocus
        autocomplete="off"
        placeholder="Projekt, Kunde, Rechnung, Adresse, Text ..."
        value="${esc(q)}"
      >

      <button class="search-button">
        Suchen
      </button>

    </div>

    <div class="examples">
      Beispiele:
      6844 Fusonic ·
      202205010 ·
      26085 ·
      Innenmalerarbeiten
    </div>

  </form>


  <div class="sources">

    <div class="source">

      <div class="source-title">
        WinWorker SQL
      </div>

      <div class="source-text">
        Projekte, Kunden, Angebote, Rechnungen,
        Beträge und Belegdaten
      </div>

      <div class="source-state">
        Connector wird angebunden
      </div>

    </div>


    <div class="source">

      <div class="source-title">
        PDF-Archiv
      </div>

      <div class="source-text">
        Volltextsuche in Angeboten,
        Rechnungen und Kundenexemplaren
      </div>

      <div class="source-state">
        Index verbunden
      </div>

    </div>

  </div>

  ${
    connectorError
      ? `<div class="connector-error">${esc(connectorError)}</div>`
      : ""
  }

  ${
    q
      ? `
        <div class="section">

          <div class="section-header">
            <div class="section-title">
              Projekte
            </div>

            <div class="result-count">
              ${projects.length} Treffer
            </div>
          </div>

          ${
            projects.length
              ? projects.map(p => `
                  <div class="card">

                    <div class="project-number">
                      ${esc(p.projectNumber)}
                      ${p.title ? " · " + esc(p.title) : ""}
                    </div>

                    <div class="customer">
                      ${esc(p.customer)}
                    </div>

                    <div class="meta">
                      ${esc(p.meta)}
                    </div>

                  </div>
                `).join("")
              : `
                  <div class="empty">
                    Noch keine SQL-Treffer.
                    <div class="hint">
                      Der lokale WinWorker-Connector wird als Nächstes angeschlossen.
                    </div>
                  </div>
                `
          }

        </div>


        <div class="section">

          <div class="section-header">

            <div class="section-title">
              Dokumente
            </div>

            <div class="result-count">
              ${documents.length} Treffer
            </div>

          </div>

          ${
            documents.length
              ? documents.map(d => `
                  <div class="card doc-card"
                       data-path="${esc(d.path)}"
                       onclick="openArchivePdf(this.dataset.path)">

                    <div class="doc-preview">
                      <img
                        loading="lazy"
                        src="/api/archive/thumb?path=${encodeURIComponent(d.path)}"
                        alt="Vorschau ${esc(d.filename)}"
                        onerror="this.style.display='none'"
                      >
                    </div>

                    <div class="doc-main">

                      <div class="doc-top">

                        <div>
                          <span class="doc-type">
                            ${esc(d.dokumenttyp || "Dokument")}
                          </span>

                          <span class="doc-name">
                            ${esc(d.filename)}
                          </span>
                        </div>

                        <button
                          class="open-button"
                          type="button"
                          data-path="${esc(d.path)}"
                          onclick="event.stopPropagation(); openArchivePdf(this.dataset.path)">
                          Öffnen
                        </button>

                      </div>

                      ${
                        d.snippet
                          ? `
                            <div class="doc-snippet">
                              ${esc(d.snippet)}
                            </div>
                          `
                          : ""
                      }

                      <div class="doc-path">
                        ${esc(d.path)}
                      </div>

                    </div>

                  </div>
                `).join("")
              : `
                  <div class="empty">
                    Noch keine Dokumenttreffer.
                    <div class="hint">
                      Keine passenden Dokumente gefunden.
                    </div>
                  </div>
                `
          }

        </div>
      `
      : `
        <div class="section">

          <div class="empty">

            Suche im Kristine-Archiv

            <div class="hint">
              Später reicht eine Eingabe wie
              „6844 Fusonic“ und Kristine durchsucht
              SQL-Daten und Dokumente gemeinsam.
            </div>

          </div>

        </div>
      `
  }

</div>

<script>
async function openArchivePdf(path) {
  try {
    const response = await fetch("/api/archive/open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      alert(data.error || "PDF konnte nicht geöffnet werden.");
    }
  } catch (err) {
    alert("Archiv-Connector nicht erreichbar.");
  }
}
</script>

</body>
</html>
`;

    res
      .status(200)
      .type("html")
      .send(html);
  });



  // ============================================================
  // Lokaler Archiv-Connector: PDF öffnen + Thumbnail
  // ============================================================

  app.post("/api/archive/open", async (req, res) => {
    try {
      const pdfPath = String(req.body?.path || "").trim();

      if (!pdfPath) {
        return res.status(400).json({
          ok: false,
          error: "PDF-Pfad fehlt"
        });
      }

      const result = await openArchiveConnector(pdfPath);
      return res.json(result);

    } catch (err) {
      console.error("Archiv PDF öffnen:", err);

      return res.status(502).json({
        ok: false,
        error: String(err?.message || err)
      });
    }
  });


  app.get("/api/archive/thumb", async (req, res) => {
    try {
      const pdfPath = String(req.query.path || "").trim();

      if (!pdfPath) {
        return res.status(400).send("PDF-Pfad fehlt");
      }

      const thumb = await loadArchiveThumbnail(pdfPath);

      res.setHeader("Content-Type", thumb.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.send(thumb.buffer);

    } catch (err) {
      console.error("Archiv Thumbnail:", err);
      return res.status(404).end();
    }
  });


  // ============================================================
  // Health / später für Connector interessant
  // ============================================================

  app.get("/api/archive/status", (req, res) => {

    res.json({
      ok: true,
      module: "archive-search",
      version: "0.2",
      sql: "pending-local-connector",
      pdfIndex: ARCHIVE_CONNECTOR
    });

  });

}

module.exports = {
  registerArchiveSearch
};