'use strict';

/**
 * KRISTINE 2.0 – sealed, read-only preview for a separate Render service.
 *
 * IMPORTANT: This is deliberately NOT the production server. It imports no
 * domain modules, opens no database, mounts no disk, and never contacts
 * WhatsApp, banking, vehicles, access control, Outlook or the production API.
 * Only anonymous fixtures are rendered. Every mutation method is rejected.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

function previewHtml(world) {
  const key = Object.prototype.hasOwnProperty.call(WORLD_NAMES, world) ? world : 'kristine';
  const label = WORLD_NAMES[key];
  return [
    '<!doctype html>',
    '<html lang="de"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow"><title>KRISTINE 2.0 · Isolierte Vorschau</title>',
    '<link rel="stylesheet" href="/public/ui/krista-ui.css">',
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
    '<div id="kristaTopbar" data-krista-active="' + htmlEscape(key) + '" data-krista-build="2.0-TEST"></div>',
    '<main class="preview">',
    '<div class="preview-head"><div><h1>KRISTINE 2.0 · ' + htmlEscape(label) + '</h1>',
    '<p>Gemeinsame Navigation, neue Struktur – zunächst ohne echte Geschäftsdaten.</p></div>',
    '<span class="stage-label">ISOLIERTE TESTVORSCHAU</span></div>',
    '<div class="preview-grid">',
    '<section class="preview-card"><strong>Live-Kristine</strong><small>Unverändert · kein Schreibzugriff von hier</small></section>',
    '<section class="preview-card"><strong>SQL-Testumgebung</strong><small>Separat eingerichtet · fachliche Anbindung folgt</small></section>',
    '<section class="preview-card"><strong>KGO</strong><small>Mitarbeiterabläufe bleiben unverändert</small></section>',
    '</div>',
    '<div class="demo-sticky"><strong>Planungsleiste – Test</strong> · Bleibt unter dem gemeinsamen Kopf sichtbar.</div>',
    '<section class="fixture"><h2>Demodaten · keine echten Mitarbeiter oder Baustellen</h2>',
    '<div class="fixture-grid" role="table" aria-label="Künstliche Beispieldaten">',
    '<strong>Nummer</strong><strong>Testbaustelle</strong><strong>Status</strong>',
    '<span>TEST-01</span><span>Musterprojekt A</span><span>Geplant</span>',
    '<span>TEST-02</span><span>Musterprojekt B</span><span>Laufend</span>',
    '</div></section>',
    '<section class="fixture"><h2>Was hier geprüft wird</h2>',
    '<p>Navigation, mobiler Kopf, Scrollen und die optische Struktur der neuen Arbeitswelten.</p>',
    '<p>Die echten KRISZEIT-, Regie-, Buchhaltungs-, Bank- und KGO-Funktionen werden erst in der abgekoppelten fachlichen Testinstanz freigegeben – nach bestandenen Tests.</p>',
    '<p class="preview-note">Dieser Server bietet keine produktiven API-Endpunkte, keine Zeitbuchung, keinen Import und keinen Zugriff auf die alte Datenbank.</p>',
    '</section>',
    '</main>',
    '<script>window.KRISTINE_V2_SAFE_PREVIEW = true;</script>',
    '<script src="/public/ui/topbar.js"></script>',
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

function createPreviewServer({ password, onRequest = () => {} } = {}) {
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
      const data = previewHtml(page.searchParams.get('world') || 'kristine');
      res.writeHead(200);
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (page.pathname === '/public/ui/krista-ui.css' || page.pathname === '/public/ui/topbar.js') {
      try {
        const value = page.pathname.endsWith('.css')
          ? fs.readFileSync(path.join(ROOT, 'public', 'ui', 'krista-ui.css'), 'utf8')
          : safeTopbarScript();
        res.setHeader('Content-Type', page.pathname.endsWith('.css')
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
  const port = Number(process.env.PORT || 10000);
  createPreviewServer({ password: process.env.KRISTINE_V2_PREVIEW_PASSWORD })
    .listen(port, '0.0.0.0', () => {
      process.stdout.write('KRISTINE_V2_ISOLATED_PREVIEW_READY\n');
    });
}

module.exports = { createPreviewServer, previewHtml, safeTopbarScript, authenticated };
