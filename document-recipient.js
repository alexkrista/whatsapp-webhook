"use strict";

const { structuredAddress } = require("./workflow-contacts");

function text(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function key(value) {
  return text(value).toLocaleLowerCase("de-AT");
}

function failure(message, status = 409) {
  return Object.assign(new Error(message), { status, code:"DOCUMENT_RECIPIENT_INVALID" });
}

function salutation(value) {
  const title = text(value, 40);
  if (/^frau(?:\b|\s)/i.test(title)) return "Frau";
  if (/^herr(?:\b|\s)/i.test(title)) return "Herr";
  return "";
}

function withoutRecipientPrefix(value) {
  return text(value).replace(/^(?:firma|frau|herr)(?:\s+|$)/i, "").trim();
}

function personRows(owner, generic, company) {
  const shared = text(owner.sharedLastName, 120);
  const role = text(owner.ownerRole, 30).toLocaleLowerCase("de-AT");
  const definitions = [
    { kind:"woman", title:owner.womanTitle, first:owner.womanFirstName || owner.firstName, last:owner.womanLastName },
    { kind:"man", title:owner.manTitle, first:owner.manFirstName, last:owner.manLastName },
  ];
  const seen = new Set(), rows = [];
  for (const definition of definitions) {
    const first = text(definition.first, 100), explicit = salutation(definition.title);
    const last = text(definition.last || (first ? shared : ""), 120);
    const lastAlreadyContainsFirst = first && (key(last) === key(generic) || key(last).startsWith(`${key(first)} `));
    let person = lastAlreadyContainsFirst ? last : text([first, last].filter(Boolean).join(" "));
    let prefix = explicit || (first ? (definition.kind === "woman" ? "Frau" : "Herr") : "");

    // Sanitized legacy records can contain the same generic surname in both
    // person slots. Only a real first name, an explicit salutation or a
    // singular owner role is enough to assign Frau/Herr.
    const singularRole = !company && ((role === "bauherrin" && definition.kind === "woman") || (role === "bauherr" && definition.kind === "man"));
    if (!person && singularRole) {
      person = withoutRecipientPrefix(generic);
      prefix = definition.kind === "woman" ? "Frau" : "Herr";
    } else if (!first && !explicit && singularRole) {
      person = withoutRecipientPrefix(generic || last);
      prefix = definition.kind === "woman" ? "Frau" : "Herr";
    }
    if (!person || !prefix) continue;

    const personKey = key(person), companyKey = key(withoutRecipientPrefix(generic));
    if ((company && personKey === companyKey) || seen.has(personKey)) continue;
    seen.add(personKey);
    rows.push({ salutation:prefix, person });
  }
  return rows;
}

function recipientNames(meta) {
  const master = meta?.customerMaster && typeof meta.customerMaster === "object" ? meta.customerMaster : {};
  const owner = meta?.projectContacts?.owner && typeof meta.projectContacts.owner === "object" ? meta.projectContacts.owner : {};
  const generic = text(owner.customer || master.name || meta?.contactName);
  const role = text(owner.ownerRole, 30).toLocaleLowerCase("de-AT");
  const company = role === "firma" || /^firma$/i.test(text(owner.womanTitle || owner.manTitle, 40));
  const people = personRows(owner, generic, company);

  if (company) {
    const companyName = withoutRecipientPrefix(generic);
    if (!companyName) throw failure("Bitte den Firmennamen in den Stammdaten ergänzen.");
    return [`Firma ${companyName}`, ...people.map(row => `z. H. ${row.salutation} ${row.person}`)];
  }
  if (people.length) return people.map(row => `${row.salutation} ${row.person}`);
  if (!generic) throw failure("Bitte den Empfänger in den Stammdaten ergänzen.");

  const explicit = salutation(generic);
  if (explicit) {
    const name = withoutRecipientPrefix(generic);
    if (!name) throw failure("Bitte den Empfänger in den Stammdaten ergänzen.");
    return [`${explicit} ${name}`];
  }
  if (role === "bauherrin") return [`Frau ${withoutRecipientPrefix(generic)}`];
  if (role === "bauherr") return [`Herr ${withoutRecipientPrefix(generic)}`];
  // With old family/builder records there is no reliable gender signal. Keep
  // the recorded name instead of silently assigning the wrong salutation.
  return [generic];
}

function recipientAddress(meta) {
  const master = meta?.customerMaster && typeof meta.customerMaster === "object" ? meta.customerMaster : {};
  const owner = meta?.projectContacts?.owner && typeof meta.projectContacts.owner === "object" ? meta.projectContacts.owner : {};
  const parsed = structuredAddress(master, master.address || "");
  const street = text(owner.residentialStreet || parsed.street, 160);
  const houseNumber = text(owner.residentialHouseNumber || parsed.houseNumber, 40);
  const postalCode = text(owner.residentialPostalCode || parsed.postalCode, 20);
  const city = text(owner.residentialCity || parsed.city, 120);
  const country = text(master.country || master.countryName, 120);
  const lines = [
    text([street, houseNumber].filter(Boolean).join(" "), 220),
    text([postalCode, city].filter(Boolean).join(" "), 160),
    country,
  ].filter(Boolean);
  return [...new Set(lines)];
}

function resolveDocumentRecipient(meta = {}) {
  const nameLines = recipientNames(meta), addressLines = recipientAddress(meta);
  return Object.freeze({
    nameLines:Object.freeze(nameLines),
    addressLines:Object.freeze(addressLines),
  });
}

function createJobDocumentPdfRenderer({ renderPdf, readJobMeta, isSafeJobId, jobExists }) {
  if ([renderPdf, readJobMeta, isSafeJobId, jobExists].some(value => typeof value !== "function")) {
    throw new TypeError("PDF-Empfängerauflösung ist unvollständig konfiguriert.");
  }
  const resolveForJob = async jobId => {
    const id = String(jobId || "").trim();
    if (!isSafeJobId(id) || !await jobExists(id)) return null;
    return resolveDocumentRecipient(await readJobMeta(id));
  };
  return async function renderJobDocumentPdf(html, options = {}) {
    const settings = { ...options };
    if (Object.prototype.hasOwnProperty.call(options, "jobId")) {
      const jobId = String(options.jobId || "").trim();
      if (!isSafeJobId(jobId)) throw failure("Ungültige Baustellennummer.", 400);
      const recipient = await resolveForJob(jobId);
      if (!recipient) throw failure("Die Baustellen-Stammdaten wurden nicht gefunden.", 404);
      settings.jobId = jobId;
      settings.recipient = recipient;
      settings.requireRecipient = true;
    } else if (options.inferRecipientJobId) {
      settings.resolveRecipient = resolveForJob;
    }
    return renderPdf(html, settings);
  };
}

module.exports = { resolveDocumentRecipient, createJobDocumentPdfRenderer };
