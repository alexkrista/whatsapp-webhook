'use strict';

/**
 * KRISTINE 2.0 – sealed, read-only preview for a separate Render service.
 *
 * IMPORTANT: This is deliberately NOT the production server. It mounts no
 * production disk and never contacts banking, door control, WhatsApp, Outlook
 * or production APIs. When explicitly configured, it only READS from the
 * separate KRISTINE 2.0 test PostgreSQL. Every mutation method is rejected.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sqlPanel } = require('./kristine-v2-preview-sql-panel');
const { readSqlOverview, verifyTestDatabaseUrl } = require('../storage/kristine-v2-sql-read-model');
const { initializeTestSchema } = require('./kristine-v2-test-schema');

const ROOT = path.resolve(__dirname, '..');
const WORLD_NAMES = Object.freeze({
  kristower: 'KRISTOWER',
  kriszeit: 'KRISZEIT',
  krisdrive: 'KRISDRIVE',
  brain: 'THE BRAIN',
  farben: 'LG',
  kristine: 'KRISTINE',
  krisadmin: 'KRISADMIN',
  tasks: 'AUFGABEN',
});
const PREVIEW_PANELS = Object.freeze({ ...WORLD_NAMES, tueren: 'TÜREN', dienste: 'DIENSTE' });

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[ch]);
}

function authenticated(req, password) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ') || header.length > 500) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const index = decoded.indexOf(':');
  if (index < 0 || decoded.slice(0, index) !== 'v2') return false;
  const actual = Buffer.from(decoded.slice(index + 1));
  const expected = Buffer.from(password);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function safeTopbarScript() {
  const file = path.join(ROOT, 'public', 'ui', 'topbar.js');
  const original = fs.readFileSync(file, 'utf8');
  const knownBrain = 'const BRAIN_URL = "https://pc-alex02.tail610122.ts.net/";';
  if (!original.includes(knownBrain)) throw new Error('Topbar source changed; review preview rewrite');
  let rewritten = original.replace(knownBrain, 'const BRAIN_URL = window.location.origin + "/preview?world=brain";');
  const brandTarget = 'tokenized("/kontrollzentrum")';
  if (!rewritten.includes(brandTarget)) throw new Error('Topbar brand target changed');
  rewritten = rewritten.replace(brandTarget, 'tokenized("/preview?world=kristower")');
  const signin = 'href="/anmelden"';
  if (!rewritten.includes(signin)) throw new Error('Topbar sign-in target changed');
  rewritten = rewritten.replace(signin, 'href="/preview?world=krisadmin"');

  let found = 0;
  rewritten = rewritten.replace(/(\{ key: "([a-z]+)",[^\r\n]*?href: )("[^"]*"|BRAIN_URL)/g, (whole, prefix, key) => {
    if (!Object.prototype.hasOwnProperty.call(WORLD_NAMES, key)) throw new Error('Unexpected navigation world');
    found++;
    return prefix + (key === 'brain' ? 'BRAIN_URL' : JSON.stringify('/preview?world=' + key));
  });
  if (found !== Object.keys(WORLD_NAMES).length) throw new Error('Unverified navigation rewrite');

  const before = '    cleanModuleNavigation();';
  if (!rewritten.includes(before)) throw new Error('Cannot disable production module loaders');
  rewritten = rewritten.replace(before,
    '    if (window.KRISTINE_V2_SAFE_PREVIEW === true) { activateKristineHash = () => {}; return; }\n' + before);
  return rewritten;
}

function previewFeaturePanel(key) {
  if (key === 'tueren') {
    const names = ['Tor', 'Eingang', 'Lager', 'Büro'];
    return [
      '<section class="fixture" aria-label="Türen und Tor – Test ohne Echtsteuerung">',
      '<h2>🚪 Türen und Tor</h2>',
      '<p><strong>TEST – NICHT VERBUNDEN.</strong> Keine Echtzustände, keine Tür- oder Torsteuerung.</p>',
      '<div class="preview-grid">',
      ...names.map(name => '<div class="preview-card"><strong>' + name + '</strong><small>Status: unbekannt · Steuerung in dieser Vorschau gesperrt</small></div>'),
      '</div>',
      '<p class="preview-note">Die Live-Kristine bietet für diese Bereiche eigene Statuslampen und Schaltbefehle. Hier sind ausschließlich Darstellung und Navigation sichtbar.</p>',
      '</section>'
    ].join('');
  }
  if (key === 'dienste') {
    const names = ['KRISTINE Cloud', 'THE BRAIN / Archiv', 'Zutritt / Türsteuerung', 'Outlook'];
    return [
      '<section class="fixture" aria-label="Dienste – Test ohne echte Dienstanbindung">',
      '<h2>🩺 Dienste</h2>',
      '<p><strong>TEST – NICHT VERBUNDEN.</strong> Keine Echtzustände, kein Starten oder Neustarten von Diensten.</p>',
      '<div class="preview-grid">',
      ...names.map(name => '<div class="preview-card"><strong>' + name + '</strong><small>Live-Status: nicht abgefragt · Aktionen deaktiviert</small></div>'),
      '</div>',
      '<p class="preview-note">Der vorhandene produktive Dienstemanager bleibt weiterhin ausschließlich in der bisherigen Kristine bedienbar.</p>',
      '</section>'
    ].join('');
  }
  return '';
}

function previewHtml(world, sqlOverview = null) {
  const key = Object.prototype.hasOwnProperty.call(PREVIEW_PANELS, world) ? world : 'kristine';
  const label = PREVIEW_PANELS[key];
  const navActive = Object.prototype.hasOwnProperty.call(WORLD_NAMES, key) ? key : 'kristine';
  return [
    '<!doctype html>',
    '<html lang="de"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow"><title>KRISTINE 2.0 · Isolierte Vorschau</title>',
    '<link rel="stylesheet" href="/public/ui/krista-ui.css">',
    '<link rel="stylesheet" href="/public/ui/kristine-v2-preview-access.css">',
    '<style>',
    'body{margin:0;min-height:165vh;font:15px/1.5 system-ui,sans-serif}',
    'main.preview{max-width:1120px;margin:28px auto 100px;padding:0 20px}',
    '.preview-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}',
    '.stage-label{display:inline-flex;padding:6px 12px;background:#e6f3e9;color:#205a35;border-radius:99px;font-size:12px;font-weight:800}',
    '.preview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:20px 0}',
    '.preview-card{background:#fff;border:1px solid #ddd9cf;border-radius:15px;padding:20px;box-shadow:0 6px 18px #20271f12}',
    '.preview-card strong{display:block;font-size:18px}.preview-card small{display:block;margin-top:6px;color:#616b63}',
    '.fixture{border:1px solid #d8dfd7;background:#fff;border-radius:15px;padding:16px;margin-top:22px}',
    '.fixture-grid{display:grid;grid-template-columns:120px 1fr 110px;gap:8px 15px}',
    '.fixture-grid>*{padding:12px 8px;border-bottom:1px solid #e9ebe6}',
    '.preview-note{color:#58655c;font-size:13px}.demo-sticky{position:sticky;top:var(--krista-topbar-height,0px);z-index:25;background:#f1f5ed;border:1px solid #dee5db;border-radius:10px;padding:12px;margin-top:18px}',
    '@media(max-width:640px){main.preview{padding:0 12px}.fixture-grid{grid-template-columns:80px 1fr 60px;font-size:12px}}',
    '</style></head><body>',
    '<div id="kristaTopbar" data-krista-active="' + htmlEscape(navActive) + '" data-krista-build="2.0-TEST"></div>',
    '<main class="preview">',
    '<div class="preview-head"><div><h1>KRISTINE 2.0 · ' + htmlEscape(label) + '</h1>',
    '<p>Gemeinsame Navigation, neue Struktur – mit gesondertem, schreibgeschütztem SQL-Testbestand.</p></div>',
    '<span class="stage-label">ISOLIERTE TESTVORSCHAU</span></div>',
    '<div class="preview-grid">',
    '<section class="preview-card"><strong>Live-Kristine</strong><small>Unverändert · kein Schreibzugriff von hier</small></section>',
    '<section class="preview-card"><strong>SQL-Testumgebung</strong><small>Separat · Lesemodell für Baustellen, Mitarbeiter und Zeiten</small></section>',
    '<section class="preview-card"><strong>KGO</strong><small>Mitarbeiterabläufe bleiben unverändert</small></section>',
    '</div>',
    '<div class="demo-sticky"><strong>Planungsleiste – Test</strong> · Bleibt unter dem gemeinsamen Kopf sichtbar.</div>',
    previewFeaturePanel(key),
    sqlPanel(sqlOverview,key),
    '<section class="fixture"><h2>Was hier geprüft wird</h2>',
    '<p>Navigation, mobiler Kopf, Scrollen und die optische Struktur der neuen Arbeitswelten.</p>',
    '<p>Die echten KRISZEIT-, Regie-, Buchhaltungs-, Bank- und KGO-Funktionen werden erst in der abgekoppelten fachlichen Testinstanz freigegeben – nach bestandenen Tests.</p>',
    '<p class="preview-note">Dieser Server bietet keine produktiven API-Endpunkte, keine Zeitbuchung, keinen Import und keinen Zugriff auf die alte Datenbank.</p>',
    '</section>',
    '</main>',
    '<script>window.KRISTINE_V2_SAFE_PREVIEW = true;</script>',
    '<script src="/public/ui/topbar.js"></script>',
    '<script src="/public/ui/kristine-v2-preview-access.js"></script>',
    '</body></html>'
  ].join('\n');
}

const HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
});

function createPreviewServer({ password, onRequest = () => {}, readOverview = null } = {}) {
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error('A strong, dedicated preview password is required');
  }

  return http.createServer((req, res) => {
    for (const [key, value] of Object.entries(HEADERS)) res.setHeader(key, value);
    onRequest(req.method, req.url && req.url.split('?')[0]);

    if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(200);
      return res.end(req.method === 'HEAD' ? undefined : '{"ok":true,"isolated":true}');
    }
    if (!authenticated(req, password)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="KRISTINE 2.0 TEST", charset="UTF-8"');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.writeHead(401);
      return res.end('Anmeldung für die isolierte Testvorschau erforderlich.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.writeHead(405);
      return res.end();
    }

    let page;
    try { page = new URL(req.url || '/', 'https://preview.invalid'); }
    catch { res.writeHead(400); return res.end(); }

    if (page.pathname === '/' || page.pathname === '/preview') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // No SQL query is performed until after the user has authenticated.
      const world = page.searchParams.get('world') || 'kristine';
      return Promise.resolve().then(() => readOverview ? readOverview() : null)
        .catch(() => ({state:'connection_error'}))
        .then(overview => {
          const data = previewHtml(world, overview);
          res.writeHead(200);
          res.end(req.method === 'HEAD' ? undefined : data);
        });
    }
    const allowedAssets = {
      '/public/ui/krista-ui.css': 'krista-ui.css',
      '/public/ui/kristine-v2-preview-access.css': 'kristine-v2-preview-access.css',
      '/public/ui/kristine-v2-preview-access.js': 'kristine-v2-preview-access.js',
      '/public/ui/topbar.js': 'topbar.js',
    };
    if (Object.prototype.hasOwnProperty.call(allowedAssets, page.pathname)) {
      try {
        const isStylesheet = page.pathname.endsWith('.css');
        const value = page.pathname === '/public/ui/topbar.js'
          ? safeTopbarScript()
          : fs.readFileSync(path.join(ROOT, 'public', 'ui', allowedAssets[page.pathname]), 'utf8');
        res.setHeader('Content-Type', isStylesheet
          ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.writeHead(200);
        return res.end(req.method === 'HEAD' ? undefined : value);
      } catch {
        res.writeHead(503);
        return res.end('Preview source check failed.');
      }
    }
    res.writeHead(404);
    res.end();
  });
}

if (require.main === module) {
  const forbidden = [
    'DATABASE_URL','DATA_DIR','ADMIN_TOKEN','WHATSAPP_TOKEN','SMTP_PASS',
    'OPENAI_API_KEY','KRISTINE_SQL_PASSWORD','REVOLUT_CLIENT_SECRET'
  ];
  if (process.env.KRISTINE_V2_PREVIEW_ONLY !== '1' ||
      process.env.KRISTINE_V2_EXTERNAL_ACTIONS !== 'disabled' ||
      forbidden.some(key => Boolean(process.env[key]))) {
    process.stderr.write('Preview isolation validation failed; not starting.\n');
    process.exit(1);
  }
  // The explicit database name, user and Render hostname must match our
  // isolated test DB. The production DATABASE_URL remains forbidden above.
  let readOverview = null;
  let testPool = null;
  const testUrl = process.env.KRISTINE_V2_TEST_DATABASE_URL;
  if (testUrl) {
    verifyTestDatabaseUrl(testUrl);
    // Pinned, licensed driver bundled for this isolated preview only.
    const { Pool } = require('./kristine-v2-pg-bundle.cjs');
    const pool = new Pool({
      connectionString:testUrl, max:2,
      connectionTimeoutMillis:3000,
      idleTimeoutMillis:10000,
      query_timeout:5000,
      statement_timeout:5000,
      application_name:'kristine-v2-readonly-preview',
    });
    pool.on('error', () => {}); // Never log a credential-bearing URI.
    testPool = pool;
    readOverview = () => readSqlOverview(pool,{
      companyId:process.env.KRISTINE_V2_COMPANY_ID || null,
    });
  }
  const port = Number(process.env.PORT || 10000);
  Promise.resolve()
    .then(async () => {
      // Explicitly opted-in; creates schema only when ALL core tables are
      // missing and only on the allocated TEST database.
      if (testPool && process.env.KRISTINE_V2_INIT_SCHEMA === '1') {
        const result = await initializeTestSchema(testPool);
        process.stdout.write('KRISTINE_V2_TEST_SCHEMA_' + result.state.toUpperCase() + '\n');
      }
    })
    .then(() => {
      createPreviewServer({ password: process.env.KRISTINE_V2_PREVIEW_PASSWORD, readOverview })
        .listen(port, '0.0.0.0', () => {
          process.stdout.write('KRISTINE_V2_ISOLATED_PREVIEW_READY\n');
        });
    })
    .catch(() => {
      // Fail closed; raw Postgres error text may contain connection details.
      process.stderr.write('KRISTINE 2.0 test SQL initialization failed.\n');
      process.exitCode = 1;
    });
}

module.exports = { createPreviewServer, previewHtml, safeTopbarScript, authenticated };
