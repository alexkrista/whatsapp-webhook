"use strict";

// Read-only personal Revolut account via Enable Banking AIS. No payment endpoints.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const BASE = "https://api.enablebanking.com";
const CALLBACK = "https://protokoll.krista.at/banking/enablebanking/callback";
const MIN_INTERVAL = 24 * 60 * 60 * 1000;
const STATE_TTL = 15 * 60 * 1000;

function jwt(appId, key) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ typ:"JWT", alg:"RS256", kid:appId })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss:"enablebanking.com", aud:"api.enablebanking.com", iat:now, exp:now + 3600 })).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

function normalize(tx, iban) {
  if (tx.status !== "BOOK") return null;
  const amount = Number(tx.transaction_amount?.amount);
  if (!Number.isFinite(amount) || !["CRDT", "DBIT"].includes(tx.credit_debit_indicator)) return null;
  const signed = Math.abs(amount) * (tx.credit_debit_indicator === "DBIT" ? -1 : 1);
  const date = String(tx.booking_date || tx.value_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const reference = String(tx.reference_number || tx.remittance_information?.join(" ") || tx.note || "").slice(0, 500);
  const merchant = String((signed < 0 ? tx.creditor?.name : tx.debtor?.name) || tx.bank_transaction_code?.description || "Revolut").slice(0, 200);
  const stable = String(tx.entry_reference || "");
  // The entry reference is stable across authorizations; fallback is deterministic but may merge identical entries.
  const id = crypto.createHash("sha256").update(JSON.stringify([iban, stable || null, stable ? null : [date, signed, tx.transaction_amount?.currency, merchant, reference]])).digest("hex");
  return { id, bookingDate:date, valueDate:String(tx.value_date || date).slice(0, 10), amount:signed.toFixed(2), currency:tx.transaction_amount.currency, merchant, reference };
}

function register(app, { dataDir, requireAdmin, request = fetch, config = process.env }) {
  const file = path.join(dataDir, "_kristine", "enable-banking-personal.json");
  let pendingWrite = Promise.resolve();
  let pendingSync = null;
  const iban = String(config.ENABLE_BANKING_EXPECTED_IBAN || "").replace(/\s/g, "").toUpperCase();
  const configured = () => config.ENABLE_BANKING_ACTIVE === "1" && /^[A-Z]{2}[A-Z0-9]{13,32}$/.test(iban) && Boolean(config.ENABLE_BANKING_APP_ID && (config.ENABLE_BANKING_PRIVATE_KEY || config.ENABLE_BANKING_PRIVATE_KEY_FILE));
  async function key() {
    return config.ENABLE_BANKING_PRIVATE_KEY_FILE
      ? fs.readFile(config.ENABLE_BANKING_PRIVATE_KEY_FILE, "utf8")
      : String(config.ENABLE_BANKING_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  }
  async function api(method, url, body) {
    const target = new URL(url, BASE);
    if (target.origin !== BASE) throw Error("Ungültiger API-Endpunkt");
    const response = await request(target, { method, headers:{ Authorization:`Bearer ${jwt(config.ENABLE_BANKING_APP_ID, await key())}`, Accept:"application/json", ...(body ? { "Content-Type":"application/json" } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`Enable Banking meldet HTTP ${response.status}`);
    return response.json();
  }
  async function read() {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  async function save(value) {
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive:true, mode:0o700 });
      const temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(value), { mode:0o600, flag:"wx" }); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force:true }).catch(() => {}); }
    });
    await pendingWrite;
  }
  function access(req, res) {
    // Never accept a bank access token in a URL (logs, browser history, referrer).
    if (req.query?.token) { res.status(403).json({ ok:false, error:"Token im URL nicht zulässig" }); return false; }
    if (!requireAdmin(req, res)) return false;
    if (req.kristineActor && !req.kristineActor.permissions?.employeeAdmin) {
      res.status(403).json({ ok:false, error:"Bankzugriff nicht freigegeben" }); return false;
    }
    return true;
  }
  async function sync() {
    if (pendingSync) return pendingSync;
    pendingSync = (async () => {
      const data = await read();
      if (!data.accountUid || !data.sessionId) throw Error("Bankfreigabe fehlt");
      if (Date.parse(data.validUntil || "") <= Date.now()) throw Error("Bankfreigabe abgelaufen; bitte erneuern");
      if (Date.now() - Date.parse(data.updatedAt || 0) < MIN_INTERVAL) return data;
      const uid = encodeURIComponent(data.accountUid);
      const balance = await api("GET", `/accounts/${uid}/balances`);
      const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const params = new URLSearchParams({ date_from:from, transaction_status:"BOOK" });
      const seenKeys = new Set();
      const transactions = [];
      for (let i = 0; i < 100; i++) {
        const page = await api("GET", `/accounts/${uid}/transactions?${params}`);
        if (!Array.isArray(page.transactions)) throw Error("Unvollständige Buchungsantwort");
        transactions.push(...page.transactions);
        if (!page.continuation_key) break;
        if (seenKeys.has(page.continuation_key) || i === 99) throw Error("Buchungsseiten konnten nicht vollständig geladen werden");
        seenKeys.add(page.continuation_key);
        params.set("continuation_key", page.continuation_key);
      }
      const byId = new Map((data.transactions || []).map(item => [item.id, item]));
      for (const tx of transactions) { const item = normalize(tx, iban); if (item) byId.set(item.id, item); }
      data.transactions = [...byId.values()].sort((a,b) => b.bookingDate.localeCompare(a.bookingDate)).slice(0, 2000);
      data.balances = (balance.balances || []).map(b => ({ type:b.balance_type, amount:b.balance_amount?.amount, currency:b.balance_amount?.currency, date:b.reference_date }));
      data.updatedAt = new Date().toISOString();
      await save(data);
      return data;
    })().finally(() => { pendingSync = null; });
    return pendingSync;
  }
  app.get("/banking/enablebanking", (req,res) => {
    if (!access(req,res)) return;
    res.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "public", "enable-banking-personal.html"));
  });
  app.get("/banking/enablebanking/status", async (req,res) => {
    if (!access(req,res)) return;
    try {
      let data = await read();
      let syncError;
      if (configured() && data.accountUid && Date.now() - Date.parse(data.updatedAt || 0) >= MIN_INTERVAL) {
        try { data = await sync(); } catch (error) { syncError = error.message; }
      }
      res.set("Cache-Control", "no-store").json({ ok:true, configured:configured(), connected:Boolean(data.accountUid), iban:data.accountUid ? iban : undefined, validUntil:data.validUntil, updatedAt:data.updatedAt, balances:data.balances || [], transactions:data.transactions || [], syncError });
    }
    catch { res.status(500).json({ ok:false, error:"Bankstatus derzeit nicht verfügbar" }); }
  });
  app.post("/banking/enablebanking/connect", async (req,res) => {
    if (!access(req,res)) return;
    if (!configured()) return res.status(503).json({ ok:false, error:"Enable Banking ist noch nicht aktiviert" });
    try {
      const state = crypto.randomBytes(32).toString("base64url");
      const response = await api("POST", "/auth", { access:{ valid_until:new Date(Date.now() + 90 * 86400000).toISOString() }, aspsp:{ name:"Revolut", country:"AT" }, state, redirect_url:CALLBACK, psu_type:"personal", language:"de" });
      const url = new URL(response.url);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".enablebanking.com")) throw Error("Ungültige Freigabeadresse");
      const data = await read();
      data.pending = { state, expires:Date.now() + STATE_TTL };
      await save(data);
      res.set("Cache-Control", "no-store").json({ ok:true, url:url.href });
    } catch (error) { res.status(502).json({ ok:false, error:error.message }); }
  });
  app.get("/banking/enablebanking/callback", async (req,res) => {
    try {
      const data = await read();
      const state = String(req.query.state || "");
      if (!data.pending || Date.now() > data.pending.expires || !state || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(data.pending.state))) throw Error("Freigabe ungültig oder abgelaufen");
      delete data.pending;
      await save(data); // consume state before exchange; replay cannot authorize twice
      if (req.query.error) throw Error("Bankfreigabe abgebrochen");
      const code = String(req.query.code || "");
      if (!code) throw Error("Freigabecode fehlt");
      const session = await api("POST", "/sessions", { code });
      const account = (session.accounts || []).find(a => String(a.account_id?.iban || "").replace(/\s/g, "").toUpperCase() === iban);
      if (!account?.uid || !session.session_id) throw Error("Das freigegebene Konto stimmt nicht mit dem gewünschten Revolut-Konto überein");
      data.sessionId = session.session_id;
      data.accountUid = account.uid;
      data.validUntil = session.access?.valid_until;
      data.updatedAt = null;
      await save(data);
      res.redirect(303, "/banking/enablebanking?connected=1");
    } catch (error) { res.status(400).type("text/plain").send(`Bankfreigabe fehlgeschlagen: ${error.message}`); }
  });
  app.post("/banking/enablebanking/sync", async (req,res) => {
    if (!access(req,res)) return;
    if (!configured()) return res.status(503).json({ ok:false, error:"Enable Banking ist noch nicht aktiviert" });
    try { const data = await sync(); res.json({ ok:true, updatedAt:data.updatedAt, transactions:data.transactions.length }); }
    catch (error) { res.status(502).json({ ok:false, error:error.message }); }
  });
  return { sync, read };
}

module.exports = { register, jwt, normalize };
