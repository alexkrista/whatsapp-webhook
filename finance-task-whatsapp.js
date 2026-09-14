"use strict";

function financeTaskWhatsAppDetail(reminder) {
  const marker = "[FINANCE_APPROVAL]";
  const text = String(reminder || "");
  if (!text.includes(marker)) return "";
  const meta = {};
  for (const part of text.split(marker, 2)[1].split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    try { meta[key] = decodeURIComponent(part.slice(separator + 1)); }
    catch { meta[key] = part.slice(separator + 1); }
  }
  const amount = Number(String(meta.amount || "0").replace(",", "."));
  if (!Number.isFinite(amount)) return "💶 Betrag: –";
  const currency = /^[A-Z]{3}$/.test(String(meta.currency || "").toUpperCase()) ? String(meta.currency).toUpperCase() : "EUR";
  try { return `💶 Betrag: ${new Intl.NumberFormat("de-AT", { style: "currency", currency }).format(amount)}`; }
  catch { return `💶 Betrag: ${amount.toFixed(2)} ${currency}`; }
}

module.exports = { financeTaskWhatsAppDetail };
