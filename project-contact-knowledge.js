"use strict";
const { structuredAddress } = require("./workflow-contacts");

// Empty controls in a partial contact form are not new knowledge.
function mergeContactKnowledge(previous = {}, incoming = {}) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) continue;
    if (Array.isArray(value)) { if (value.length || !Array.isArray(result[key])) result[key] = value; }
    else if (typeof value === "object") result[key] = mergeContactKnowledge(result[key] || {}, value);
    else result[key] = value;
  }
  return result;
}

function completeProjectContacts(previous, incoming, meta = {}) {
  const contacts = mergeContactKnowledge(previous, incoming);
  const owner = { ...(contacts.owner || {}) };
  const master = meta.customerMaster || {};
  if (master.role && master.role !== "customer" && master.role !== "owner") return contacts;
  const name = String(master.name || meta.contactName || "").trim();
  // Do not mix details from a different explicitly selected customer.
  if (owner.customer && name && owner.customer !== name) return { ...contacts, owner };
  owner.customer ||= name;
  const title = name.match(/^(Frau|Herr)\s+(.+)$/i);
  const hasPerson = [owner.womanFirstName,owner.womanLastName,owner.manFirstName,owner.manLastName,owner.firstName].some(Boolean);
  if (title && !hasPerson) {
    const woman = title[1].toLowerCase() === "frau";
    const prefix = woman ? "woman" : "man";
    owner[prefix + "Title"] ||= woman ? "Frau" : "Herr";
    // Preserve the recorded name; do not infer a first name from an email.
    owner[prefix + "LastName"] ||= title[2];
    if (!owner.ownerRole || owner.ownerRole === "Bauherrschaft") owner.ownerRole = woman ? "Bauherrin" : "Bauherr";
  }
  const woman = owner.ownerRole === "Bauherrin" || (!!owner.womanTitle && !owner.manTitle);
  const phone = String(master.phone || meta.contactPhone || "").trim();
  const email = String(master.email || meta.contactEmail || "").trim();
  if (!owner.phoneOwnerWoman && !owner.phoneOwnerMan) owner[woman ? "phoneOwnerWoman" : "phoneOwnerMan"] = phone;
  if (!owner.womanEmail && !owner.manEmail && !owner.email) {
    owner.email = email;
    if (woman) owner.womanEmail = email;
  }
  // Only the recorded customer address is a residence; never assume the site address.
  const address = structuredAddress(master);
  const fields = { residentialStreet:"street", residentialHouseNumber:"houseNumber", residentialPostalCode:"postalCode", residentialCity:"city" };
  const compatible = Object.entries(fields).every(([key,source]) => !owner[key] || !address[source] || owner[key] === address[source]);
  if (compatible) for (const [key, source] of Object.entries(fields)) owner[key] ||= address[source];
  // Explicit empty person slots avoid inventing a second builder during sanitization.
  owner.sharedLastName ??= ""; owner.womanLastName ??= ""; owner.manLastName ??= "";
  return { ...contacts, owner };
}
module.exports = { mergeContactKnowledge, completeProjectContacts };
