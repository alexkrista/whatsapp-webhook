"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const CONTACT_ROLES = new Set(["owner", "siteManager", "architect"]);

function cleanText(value, limit = 240) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, limit);
}

function normalize(value) {
  return cleanText(value, 2000)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@+.]+/g, " ")
    .trim();
}

function phoneKey(value) {
  const digits = cleanText(value, 100).replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(-12) : "";
}

function compactAddress(street, houseNumber, postalCode, city) {
  return [street, houseNumber, [postalCode, city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function cleanExtras(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 20).map(row => ({
    label: cleanText(row?.label, 100),
    value: cleanText(row?.value, 240),
  })).filter(row => row.label || row.value);
}

function cleanRoleData(value, role) {
  const row = value && typeof value === "object" ? value : {};
  const common = {
    masterContactId: cleanText(row.masterContactId, 80),
    company: cleanText(row.company, 180),
    title: cleanText(row.title, 40),
    firstName: cleanText(row.firstName, 100),
    lastName: cleanText(row.lastName, 120),
    phone: cleanText(row.phone, 80),
    email: cleanText(row.email, 180),
    street: cleanText(row.street, 140),
    houseNumber: cleanText(row.houseNumber, 40),
    postalCode: cleanText(row.postalCode, 20),
    city: cleanText(row.city, 100),
    source: cleanText(row.source, 30),
    wwAddressId: cleanText(row.wwAddressId, 80),
    wwCustomerNumber: cleanText(row.wwCustomerNumber, 80),
    wwKey: cleanText(row.wwKey, 120),
    uid: cleanText(row.uid, 40), website: cleanText(row.website, 500), sourceUrl: cleanText(row.sourceUrl, 500), sourceCheckedAt: cleanText(row.sourceCheckedAt, 40),
    extraLines: cleanExtras(row.extraLines),
  };
  if (role !== "owner") return { ...common, alsoArchitect: !!row.alsoArchitect };
  return {
    ...common,
    customer: cleanText(row.customer, 180),
    ownerRole: cleanText(row.ownerRole, 30) || "Bauherrschaft",
    sharedLastName: row.ownerRole === "Firma" ? "" : cleanText(row.sharedLastName, 120),
    womanTitle: cleanText(row.womanTitle, 40),
    womanFirstName: cleanText(row.womanFirstName || row.firstName, 100),
    womanLastName: cleanText(row.womanLastName || (row.ownerRole === "Firma" ? "" : row.sharedLastName), 120),
    womanEmail: cleanText(row.womanEmail || row.email, 180),
    manTitle: cleanText(row.manTitle, 40),
    manFirstName: cleanText(row.manFirstName, 100),
    manLastName: cleanText(row.manLastName || (row.ownerRole === "Firma" ? "" : row.sharedLastName), 120),
    manEmail: cleanText(row.manEmail, 180),
    residentialStreet: cleanText(row.residentialStreet || row.street, 140),
    residentialHouseNumber: cleanText(row.residentialHouseNumber || row.houseNumber, 40),
    residentialPostalCode: cleanText(row.residentialPostalCode || row.postalCode, 20),
    residentialCity: cleanText(row.residentialCity || row.city, 100),
    phoneOwnerWoman: cleanText(row.phoneOwnerWoman, 80),
    phoneOwnerMan: cleanText(row.phoneOwnerMan || row.phone, 80),
  };
}

function roleCandidate(jobId, role, raw, meta = {}) {
  const data = cleanRoleData(raw, role);
  const master = meta.customerMaster && typeof meta.customerMaster === "object" ? meta.customerMaster : {};
  if (role === "owner") {
    data.wwAddressId ||= cleanText(meta.wwAddressId || master.wwAddressId, 80);
    data.wwCustomerNumber ||= cleanText(meta.wwCustomerNumber || master.wwCustomerNumber, 80);
    data.wwKey ||= cleanText(master.wwKey, 120);
    data.source ||= data.wwAddressId ? "winworker" : "kristine";
    const people = [
      [data.womanTitle, data.womanFirstName, data.womanLastName].filter(Boolean).join(" "),
      [data.manTitle, data.manFirstName, data.manLastName].filter(Boolean).join(" "),
    ].filter(Boolean).join(" und ");
    const displayName = data.customer || people || cleanText(meta.contactName, 180);
    const email = data.womanEmail || data.manEmail || data.email || cleanText(meta.contactEmail, 180);
    const phone = data.phoneOwnerWoman || data.phoneOwnerMan || data.phone || cleanText(meta.contactPhone, 80);
    const street = data.residentialStreet;
    const houseNumber = data.residentialHouseNumber;
    const postalCode = data.residentialPostalCode;
    const city = data.residentialCity;
    if (![displayName, email, phone, street, postalCode, city].some(Boolean)) return null;
    return {
      masterContactId: data.masterContactId,
      role,
      displayName,
      company: data.customer,
      title: data.womanTitle || data.manTitle,
      firstName: data.womanFirstName || data.manFirstName,
      lastName: data.womanLastName || data.manLastName || data.sharedLastName,
      phone,
      email,
      street,
      houseNumber,
      postalCode,
      city,
      wwAddressId: data.wwAddressId,
      wwCustomerNumber: data.wwCustomerNumber,
      wwKey: data.wwKey,
      source: data.source,
      jobId: cleanText(jobId, 100),
      roleData: data,
    };
  }
  const displayName = [data.title, data.firstName, data.lastName].filter(Boolean).join(" ") || data.company;
  if (![displayName, data.company, data.email, data.phone, data.street, data.postalCode, data.city].some(Boolean)) return null;
  return {
    masterContactId: data.masterContactId,
    role,
    displayName,
    company: data.company,
    title: data.title,
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    email: data.email,
    street: data.street,
    houseNumber: data.houseNumber,
    postalCode: data.postalCode,
    city: data.city,
    wwAddressId: data.wwAddressId,
    wwCustomerNumber: data.wwCustomerNumber,
    wwKey: data.wwKey,
    source: data.source || (data.wwAddressId ? "winworker" : "kristine"),
    jobId: cleanText(jobId, 100),
    roleData: data,
  };
}

function candidatesFromMeta(jobId, meta = {}) {
  const contacts = meta.projectContacts && typeof meta.projectContacts === "object" ? meta.projectContacts : {};
  return ["owner", "siteManager", "architect"].map(role => roleCandidate(jobId, role, contacts[role], meta)).filter(Boolean);
}

function cleanStoredContact(value) {
  const row = value && typeof value === "object" ? value : {};
  const roles = [...new Set((Array.isArray(row.roles) ? row.roles : []).map(String).filter(role => CONTACT_ROLES.has(role)))];
  const roleData = {};
  for (const role of roles) roleData[role] = cleanRoleData(row.roleData?.[role], role);
  return {
    id: cleanText(row.id, 80) || `contact_${crypto.randomUUID()}`,
    roles,
    displayName: cleanText(row.displayName, 180),
    company: cleanText(row.company, 180),
    title: cleanText(row.title, 40),
    firstName: cleanText(row.firstName, 100),
    lastName: cleanText(row.lastName, 120),
    phone: cleanText(row.phone, 80),
    email: cleanText(row.email, 180),
    street: cleanText(row.street, 140),
    houseNumber: cleanText(row.houseNumber, 40),
    postalCode: cleanText(row.postalCode, 20),
    city: cleanText(row.city, 100),
    address: compactAddress(row.street, row.houseNumber, row.postalCode, row.city),
    wwAddressId: cleanText(row.wwAddressId, 80),
    wwCustomerNumber: cleanText(row.wwCustomerNumber, 80),
    wwKey: cleanText(row.wwKey, 120),
    source: cleanText(row.source, 30) || "kristine",
    roleData,
    projectIds: [...new Set((Array.isArray(row.projectIds) ? row.projectIds : []).map(value => cleanText(value, 100)).filter(Boolean))].slice(-100),
    createdAt: cleanText(row.createdAt, 40) || new Date().toISOString(),
    updatedAt: cleanText(row.updatedAt, 40) || new Date().toISOString(),
  };
}

function identityKeys(row) {
  const keys = [];
  if (row.wwAddressId) keys.push(`ww:${normalize(row.wwAddressId)}`);
  if (row.email) keys.push(`email:${normalize(row.email)}`);
  const phone = phoneKey(row.phone);
  if (phone) keys.push(`phone:${phone}`);
  const name = normalize([row.company, row.firstName, row.lastName, row.displayName].filter(Boolean).join(" "));
  const address = normalize(compactAddress(row.street, row.houseNumber, row.postalCode, row.city));
  if (name) keys.push(`name:${name}|${address}`);
  return keys;
}

function mergeNonEmpty(oldValue, newValue) {
  if (Array.isArray(newValue)) return newValue.length ? newValue : (Array.isArray(oldValue) ? oldValue : []);
  if (newValue && typeof newValue === "object") {
    const out = { ...(oldValue && typeof oldValue === "object" ? oldValue : {}) };
    for (const [key, value] of Object.entries(newValue)) out[key] = mergeNonEmpty(out[key], value);
    return out;
  }
  return newValue === "" || newValue === undefined || newValue === null ? oldValue : newValue;
}

function mergeCandidates(rows, candidates, now = new Date().toISOString()) {
  const contacts = (Array.isArray(rows) ? rows : []).map(cleanStoredContact);
  const ids = {};
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || !CONTACT_ROLES.has(candidate.role)) continue;
    const candidateKeys = new Set(identityKeys(candidate));
    let index = candidate.masterContactId ? contacts.findIndex(row => row.id === candidate.masterContactId) : -1;
    if (index < 0 && candidateKeys.size) index = contacts.findIndex(row => identityKeys(row).some(key => candidateKeys.has(key)));
    const existing = index >= 0 ? contacts[index] : null;
    const id = existing?.id || candidate.masterContactId || `contact_${crypto.randomUUID()}`;
    const explicit = !!existing && !!candidate.masterContactId && existing.id === candidate.masterContactId;
    const previousRole = existing?.roleData?.[candidate.role] || {};
    const nextRole = explicit ? cleanRoleData(candidate.roleData, candidate.role) : mergeNonEmpty(previousRole, cleanRoleData(candidate.roleData, candidate.role));
    const next = cleanStoredContact({
      ...(existing || {}),
      id,
      roles: [...new Set([...(existing?.roles || []), candidate.role])],
      displayName: candidate.displayName || existing?.displayName,
      company: candidate.company || existing?.company,
      title: candidate.title || existing?.title,
      firstName: candidate.firstName || existing?.firstName,
      lastName: candidate.lastName || existing?.lastName,
      phone: candidate.phone || existing?.phone,
      email: candidate.email || existing?.email,
      street: candidate.street || existing?.street,
      houseNumber: candidate.houseNumber || existing?.houseNumber,
      postalCode: candidate.postalCode || existing?.postalCode,
      city: candidate.city || existing?.city,
      wwAddressId: candidate.wwAddressId || existing?.wwAddressId,
      wwCustomerNumber: candidate.wwCustomerNumber || existing?.wwCustomerNumber,
      wwKey: candidate.wwKey || existing?.wwKey,
      source: candidate.wwAddressId ? "winworker" : (candidate.source || existing?.source || "kristine"),
      roleData: { ...(existing?.roleData || {}), [candidate.role]: { ...nextRole, masterContactId: id } },
      projectIds: [...new Set([...(existing?.projectIds || []), candidate.jobId].filter(Boolean))],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    if (index >= 0) contacts[index] = next;
    else contacts.push(next);
    ids[candidate.role] = id;
  }
  return { contacts, ids };
}

function searchContacts(rows, query, role = "", limit = 20) {
  const selectedRole = CONTACT_ROLES.has(String(role)) ? String(role) : "";
  const needle = normalize(query);
  const terms = needle.split(/\s+/).filter(Boolean);
  const available = (Array.isArray(rows) ? rows : []).map(cleanStoredContact)
    .filter(row => !selectedRole || row.roles.includes(selectedRole));
  if (!terms.length) return available
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.displayName.localeCompare(b.displayName, "de"))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)));
  return available
    .map(row => {
      const roleRows = Object.values(row.roleData || {});
      const hay = normalize(JSON.stringify({ ...row, roleData: roleRows }));
      if (!terms.every(term => hay.includes(term))) return null;
      const name = normalize(row.displayName || row.company);
      let score = terms.reduce((sum, term) => sum + (name === term ? 100 : name.startsWith(term) ? 50 : name.includes(term) ? 20 : 1), 0);
      if (row.wwAddressId) score += 2;
      return { row, score };
    }).filter(Boolean)
    .sort((a, b) => b.score - a.score || String(b.row.updatedAt).localeCompare(String(a.row.updatedAt)) || a.row.displayName.localeCompare(b.row.displayName, "de"))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)))
    .map(item => item.row);
}

function createContactMasterStore({ dataDir, readJobMeta, isJobId }) {
  const file = path.join(dataDir, "_kristine", "contact-master.json");
  let queue = Promise.resolve();
  let backfillPromise = null;

  async function read() {
    try {
      const rows = JSON.parse(await fsp.readFile(file, "utf8"));
      return Array.isArray(rows) ? rows.map(cleanStoredContact) : [];
    } catch {
      return [];
    }
  }

  async function write(rows) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(rows, null, 2), "utf8");
    await fsp.rename(temporary, file);
  }

  function mutate(mutator) {
    const task = queue.then(async () => {
      const rows = await read();
      const result = await mutator(rows);
      if (result?.contacts) await write(result.contacts);
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }

  async function captureJob(jobId, meta) {
    const candidates = candidatesFromMeta(jobId, meta);
    if (!candidates.length) return {};
    const result = await mutate(rows => mergeCandidates(rows, candidates));
    return result.ids;
  }

  async function backfill() {
    if (backfillPromise) return backfillPromise;
    backfillPromise = mutate(async rows => {
      const entries = await fsp.readdir(dataDir, { withFileTypes: true }).catch(() => []);
      let contacts = rows;
      for (const entry of entries) {
        const jobId = entry.name;
        if (!entry.isDirectory() || !jobId || jobId.startsWith("_") || jobId === "unknown" || (isJobId && !isJobId(jobId))) continue;
        const meta = await readJobMeta(jobId).catch(() => null);
        if (!meta) continue;
        contacts = mergeCandidates(contacts, candidatesFromMeta(jobId, meta), meta.updatedAt || new Date().toISOString()).contacts;
      }
      return { contacts };
    }).catch(error => {
      backfillPromise = null;
      throw error;
    });
    return backfillPromise;
  }

  async function search(query, role, limit) {
    await backfill();
    await queue;
    return searchContacts(await read(), query, role, limit);
  }

  return { file, read, write, captureJob, backfill, search };
}

module.exports = {
  CONTACT_ROLES,
  candidatesFromMeta,
  mergeCandidates,
  searchContacts,
  createContactMasterStore,
};
