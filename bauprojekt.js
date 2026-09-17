'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('./public/bauprojekt/engine');

const root = path.join(__dirname, 'public', 'bauprojekt');
const SHARE_HOURS = 48;

function httpError(message, status) {
  return Object.assign(Error(message), { status });
}

function createStore(dataDir) {
  const dir = path.join(dataDir, '_bauprojekt');
  const sharesFile = path.join(dir, '_shares.json');
  let pending = Promise.resolve();

  const valid = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw httpError('Ungültige Projekt-ID', 400);
    return path.join(dir, id + '.json');
  };
  const queue = action => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  const tokenHash = secret => crypto.createHash('sha256').update(secret).digest('hex');

  async function read(id) {
    try {
      return JSON.parse(await fs.readFile(valid(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError('Projekt nicht gefunden', 404);
      throw error;
    }
  }

  function write(project, create = false) {
    return queue(async () => {
      engine.validate(project);
      await fs.mkdir(dir, { recursive: true });
      const file = valid(project.id);
      if (!create) {
        const old = await read(project.id);
        if (old.revision !== project.revision) {
          throw httpError('Projekt wurde inzwischen geändert. Bitte neu laden.', 409);
        }
      }
      const value = {
        ...project,
        revision: create ? 1 : project.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const temporary = file + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(temporary, file);
      return value;
    });
  }

  async function readShares() {
    try {
      const value = JSON.parse(await fs.readFile(sharesFile, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function writeShares(rows) {
    await fs.mkdir(dir, { recursive: true });
    const temporary = sharesFile + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(rows, null, 2), 'utf8');
    await fs.rename(temporary, sharesFile);
  }

  async function createShare(projectId, hours = SHARE_HOURS) {
    await read(projectId);
    if (hours !== SHARE_HOURS) throw httpError('Freigaben sind auf 48 Stunden festgelegt.', 400);
    const shareId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const grant = {
      id: shareId,
      projectId,
      tokenHash: tokenHash(secret),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 60 * 60 * 1000).toISOString(),
    };
    await queue(async () => {
      const active = (await readShares()).filter(row => Date.parse(row.expiresAt) > now);
      active.push(grant);
      await writeShares(active);
    });
    return { token: shareId + '.' + secret, expiresAt: grant.expiresAt, projectId };
  }

  async function resolveShare(token) {
    if (typeof token !== 'string') return null;
    const match = token.match(/^([a-f0-9-]{36})\.([A-Za-z0-9_-]{40,})$/);
    if (!match) return null;
    const row = (await readShares()).find(item => item.id === match[1]);
    if (!row || Date.parse(row.expiresAt) <= Date.now()) return null;
    const actual = Buffer.from(tokenHash(match[2]), 'hex');
    const expected = Buffer.from(row.tokenHash || '', 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    return { projectId: row.projectId, expiresAt: row.expiresAt };
  }

  return {
    read,
    write,
    createShare,
    resolveShare,
    async list() {
      await fs.mkdir(dir, { recursive: true });
      const files = (await fs.readdir(dir)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
      return Promise.all(files.map(async file => {
        const project = await read(file.slice(0, -5));
        return {
          id: project.id,
          name: project.name,
          jobId: project.jobId || '',
          revision: project.revision,
          updatedAt: project.updatedAt,
        };
      }));
    },
  };
}

function registerBauprojekt(app, { dataDir, requireAdmin }) {
  const store = createStore(dataDir);
  const action = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message });
    }
  };
  const guard = action(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const share = await store.resolveShare(req.headers['x-bauprojekt-share']);
    if (share) {
      req.bauprojektShare = share;
      return req.bauprojektNext();
    }
    if (requireAdmin(req, res)) {
      req.bauprojektAdmin = true;
      req.bauprojektNext();
    }
  });
  const guarded = fn => [
    (req, res, next) => {
      req.bauprojektNext = next;
      return guard(req, res);
    },
    action(fn),
  ];
  const adminGuard = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (requireAdmin(req, res)) next();
  };
  const assertProjectAccess = (req, projectId) => {
    if (req.bauprojektShare && req.bauprojektShare.projectId !== projectId) {
      throw httpError('Dieser Testlink gilt nur für das freigegebene Projekt.', 403);
    }
  };

  app.get('/bauprojekt', (_req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.sendFile(path.join(root, 'index.html'));
  });
  app.get('/bauprojekt/freigabe', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Bauprojekt-Testlink</title><h1>Bauprojekt-Testlink</h1><p>Bitte im Bauprojekt das gewünschte Projekt öffnen und dort auf <b>48-Stunden-Testlink</b> klicken.</p><p>Der Link gilt nur für dieses eine Projekt und endet automatisch nach 48 Stunden.</p><p><a href="/bauprojekt">Bauprojekt öffnen</a></p>');
  });
  app.get('/bauprojekt/api/catalog', ...guarded(async (_req, res) => {
    res.json(JSON.parse(await fs.readFile(path.join(__dirname, 'bauprojekt-catalog.json'), 'utf8')));
  }));
  app.get('/bauprojekt/api/sample', ...guarded(async (req, res) => {
    if (req.bauprojektShare) throw httpError('Mit einem Testlink kann kein neues Beispielprojekt angelegt werden.', 403);
    res.json(JSON.parse(await fs.readFile(path.join(__dirname, 'bauprojekt-sample.json'), 'utf8')));
  }));
  app.get('/bauprojekt/api/projects', ...guarded(async (req, res) => {
    const rows = await store.list();
    res.json(req.bauprojektShare ? rows.filter(row => row.id === req.bauprojektShare.projectId) : rows);
  }));
  app.post('/bauprojekt/api/projects', ...guarded(async (req, res) => {
    if (req.bauprojektShare) throw httpError('Mit einem Testlink kann kein neues Projekt angelegt werden.', 403);
    const project = { ...req.body, id: crypto.randomUUID() };
    res.status(201).json(await store.write(project, true));
  }));
  app.get('/bauprojekt/api/projects/:id', ...guarded(async (req, res) => {
    assertProjectAccess(req, req.params.id);
    res.json(await store.read(req.params.id));
  }));
  app.put('/bauprojekt/api/projects/:id', ...guarded(async (req, res) => {
    assertProjectAccess(req, req.params.id);
    if (req.body.id !== req.params.id) throw Error('Projekt-ID stimmt nicht überein.');
    res.json(await store.write(req.body));
  }));
  app.post('/bauprojekt/api/projects/:id/shares', adminGuard, action(async (req, res) => {
    const share = await store.createShare(req.params.id);
    res.status(201).json({
      url: '/bauprojekt?share=' + encodeURIComponent(share.token),
      expiresAt: share.expiresAt,
      projectId: share.projectId,
    });
  }));
}

module.exports = { registerBauprojekt, createStore };
