"use strict";

function clean(value, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseAddress(value = "") {
  const raw = String(value || "").replace(/\r/g, "").trim();
  const lines = raw.split(/\n|,/).map(part => clean(part, 240)).filter(Boolean);
  let streetLine = lines[0] || "";
  let placeLine = lines[1] || "";
  let extraLines = lines.slice(2);

  if (!placeLine) {
    const inline = streetLine.match(/^(.*?)(?:,?\s+)(\d{4})\s+(.+)$/);
    if (inline) {
      streetLine = clean(inline[1]);
      placeLine = `${inline[2]} ${inline[3]}`;
    }
  }

  const place = placeLine.match(/^(\d{4,6})\s+(.+)$/);
  if (!place && placeLine) extraLines = [placeLine, ...extraLines];
  const street = streetLine.match(/^(.*?)(?:\s+(\d+[A-Za-z]?(?:[\/-]\d+[A-Za-z]?)?))$/);
  const postalCode = clean(place?.[1], 20);
  const city = clean(place?.[2], 120);
  const streetName = clean(street?.[1] || streetLine, 160);
  const houseNumber = clean(street?.[2], 40);
  const addressExtra = extraLines.join(", ");

  return {
    street: streetName,
    houseNumber,
    postalCode,
    city,
    addressExtra: clean(addressExtra, 300),
    formatted: [
      [streetName, houseNumber].filter(Boolean).join(" "),
      [postalCode, city].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
  };
}

function projectContactsFromMaster(master = {}, fallback = {}) {
  const source = master && typeof master === "object" ? master : {};
  const role = clean(source.role || "customer", 40);
  const name = clean(source.name || fallback.name, 180);
  const phone = clean(source.phone || fallback.phone, 80);
  const email = clean(source.email || fallback.email, 180);
  const current = fallback.projectContacts && typeof fallback.projectContacts === "object" ? fallback.projectContacts : {};
  const result = {
    ...current,
    owner: { ...(current.owner || {}) },
    siteManager: { ...(current.siteManager || {}) },
    architect: { ...(current.architect || {}) },
  };
  if (role === "architect") result.architect = { ...result.architect, company: name, phone, email };
  else if (role === "site_manager") result.siteManager = { ...result.siteManager, company: name, phone, email };
  else if (role === "customer") {
    result.owner = {
      ...result.owner,
      customer: name,
      sharedLastName: result.owner.sharedLastName || name,
      phoneOwnerMan: phone,
      email,
    };
  }
  return result;
}

function structuredAddress(source = {}, fallback = "") {
  const parsed = parseAddress(source.address || fallback);
  const street = clean(source.street || source.streetName || parsed.street, 160);
  const houseNumber = clean(source.houseNumber || source.houseNo || parsed.houseNumber, 40);
  const postalCode = clean(source.postalCode || source.zip || source.postcode || parsed.postalCode, 20);
  const city = clean(source.city || source.town || parsed.city, 120);
  const addressExtra = clean(source.addressExtra || source.addressSupplement || parsed.addressExtra, 300);
  return {
    street,
    houseNumber,
    postalCode,
    city,
    addressExtra,
    formatted: [
      [street, houseNumber].filter(Boolean).join(" "),
      [postalCode, city].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
  };
}

function contactName(person = {}) {
  return clean([
    person.title,
    person.firstName || person.womanFirstName || person.manFirstName,
    person.lastName || person.womanLastName || person.manLastName || person.sharedLastName,
  ].filter(Boolean).join(" ") || person.name || person.customer || person.company, 180);
}

function firstContact(values = []) {
  return [...new Set(values.map(value => clean(value, 180)).filter(Boolean))][0] || "";
}

function portalRecipientOptions(meta = {}) {
  const contacts = meta.projectContacts || {};
  const owner = contacts.owner || {};
  const ownerNames = [
    clean([owner.womanTitle, owner.womanFirstName || owner.firstName, owner.womanLastName || ((owner.womanFirstName || owner.firstName) ? owner.sharedLastName : "")].filter(Boolean).join(" "), 180),
    clean([owner.manTitle, owner.manFirstName, owner.manLastName || (owner.manFirstName ? owner.sharedLastName : "")].filter(Boolean).join(" "), 180),
  ].filter(Boolean);
  const ownerName = ownerNames.join(" und ") || clean(owner.customer || owner.sharedLastName || meta.contactName || meta.customerMaster?.name || meta.name, 180);
  const options = [
    {
      id: "owner",
      role: "owner",
      roleLabel: "Bauherrschaft",
      name: ownerName,
      email: firstContact([owner.womanEmail, owner.manEmail, owner.email, meta.contactEmail, meta.customerMaster?.email]),
      phone: firstContact([owner.phoneOwnerWoman, owner.phoneOwnerMan, meta.contactPhone, meta.customerMaster?.phone]),
    },
    {
      id: "siteManager",
      role: "siteManager",
      roleLabel: "Bauleitung",
      name: contactName(contacts.siteManager),
      email: clean(contacts.siteManager?.email, 180),
      phone: clean(contacts.siteManager?.phone, 80),
    },
    {
      id: "architect",
      role: "architect",
      roleLabel: "Architekt",
      name: contactName(contacts.architect),
      email: clean(contacts.architect?.email, 180),
      phone: clean(contacts.architect?.phone, 80),
    },
  ];
  return options.filter(row => row.name || row.email || row.phone);
}

function sanitizePortalRecipient(value = {}, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const old = fallback && typeof fallback === "object" ? fallback : {};
  const rawId = clean(source.id ?? old.id, 80).replace(/[^A-Za-z0-9_-]/g, "");
  const role = ["owner", "siteManager", "architect", "manual"].includes(source.role) ? source.role : (["owner", "siteManager", "architect", "manual"].includes(old.role) ? old.role : "manual");
  return {
    id: rawId || (role === "manual" ? "manual" : role),
    role,
    roleLabel: clean(source.roleLabel ?? old.roleLabel ?? (role === "owner" ? "Bauherrschaft" : role === "siteManager" ? "Bauleitung" : role === "architect" ? "Architekt" : "Empfänger"), 80),
    name: clean(source.name ?? old.name, 180),
    email: clean(source.email ?? old.email, 180),
    phone: clean(source.phone ?? old.phone, 80),
  };
}

module.exports = {
  clean,
  parseAddress,
  structuredAddress,
  projectContactsFromMaster,
  portalRecipientOptions,
  sanitizePortalRecipient,
};
