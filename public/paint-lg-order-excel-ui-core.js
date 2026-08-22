"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(Number(value || 0));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const withToken = url => url + (token ? (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : "");

  async function waitForSave(status, before) {
    if (/^Keine Änderungen/i.test(before)) return true;
    for (let i = 0; i < 100; i += 1) {
      await sleep(100);
      const text = String(status?.textContent || "").trim();
      if (/^(Gespeichert|Keine Änderungen)/i.test(text) && text !== before) return true;
      if (text !== before && /(Fehler|HTTP|Forbidden|fehl|ungültig|unbekannt)/i.test(text)) throw new Error(text);
    }
    throw new Error("Bestellmengen konnten vor dem Excel-Export nicht bestätigt werden.");
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
      reader.onerror = () => reject(new Error("Excel-Datei konnte nicht gelesen werden."));
      reader.readAsDataURL(file);
    });
  }

  async function uploadTemplate(file, status) {
    if (!file) throw new Error("Bitte das Little-Greene-Excel auswählen.");
    if (!/\.xlsx$/i.test(file.name)) throw new Error("Bitte eine .xlsx-Datei verwenden.");
    if (status) status.textContent = "Little-Greene-Vorlage wird geprüft und gespeichert …";
    const base64 = await readFileBase64(file);
    const response = await fetch(withToken("/admin/api/paint/order-review/xlsx-template"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, base64 }),
    });
    const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (status) status.innerHTML = `<strong>LG-Vorlage gespeichert ✓</strong> ${body.template?.skuCount || ""} SKU-Zeilen erkannt.`;
    return true;
  }

  async function ensureTemplate() {
    const response = await fetch(withToken("/admin/api/paint/order-review/xlsx-template/status"), { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    return !!(response.ok && body.installed);
  }

  function chooseTemplate(status) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        try { resolve(await uploadTemplate(input.files?.[0], status)); }
        catch (error) { reject(error); }
        finally { input.remove(); }
      }, { once: true });
      input.click();
    });
  }

  async function downloadExcel(status) {
    const response = await fetch(withToken("/admin/api/paint/order-review/xlsx"), { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.body = body;
      throw error;
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
    const filename = match?.[1] || `LittleGreene_Bestellung_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const kristine = response.headers.get("X-Kristine-Total");
    const lg = response.headers.get("X-LG-Total");
    if (status) status.innerHTML = `<strong>Excel fertig ✓</strong> Preisprüfung: KRISTINE ${money(kristine)} = LG ${money(lg)}. Datei öffnen, bei Bedarf Mengen ändern und an Little Greene senden.`;
  }

  async function createExcel(button) {
    const modal = document.getElementById("lgOrderReviewModal");
    const status = modal?.querySelector("#lgOrderStatus");
    const save = modal?.querySelector("#lgOrderSave");
    const oldText = button.textContent;
    button.disabled = true; button.textContent = "Excel wird erstellt …";
    try {
      if (save) {
        const before = String(status?.textContent || "").trim();
        save.click();
        await waitForSave(status, before);
      }
      if (!(await ensureTemplate())) {
        if (status) status.innerHTML = "<strong>Vorlage fehlt:</strong> Bitte einmal das KRISTA-Little-Greene-Excel auswählen.";
        await chooseTemplate(status);
      }
      if (status) status.textContent = "LG-Excel wird ausgefüllt und der Bestellpreis geprüft …";
      await downloadExcel(status);
    } catch (error) {
      const body = error?.body || {};
      let detail = String(error?.message || error);
      if (Array.isArray(body.priceMismatches) && body.priceMismatches.length) {
        const first = body.priceMismatches[0];
        detail += ` · ${first.sku}: KRISTINE ${money(first.kristinePrice)} / LG ${money(first.lgPrice)}`;
      } else if (Array.isArray(body.missing) && body.missing.length) {
        detail += ` · fehlende SKU: ${body.missing[0].sku}`;
      }
      if (status) status.textContent = detail;
    } finally {
      button.disabled = false; button.textContent = oldText;
    }
  }

  function install() {
    const modal = document.getElementById("lgOrderReviewModal");
    if (!modal) return false;
    const actions = modal.querySelector(".lg-order-actions");
    if (!actions || document.getElementById("lgOrderExcel")) return true;
    const button = document.createElement("button");
    button.id = "lgOrderExcel";
    button.className = "btn primary";
    button.type = "button";
    button.textContent = "LG-Excel erstellen";
    button.title = "Originales Little-Greene-Bestellformular ausfüllen und Bestellpreis gegen KRISTINE prüfen";
    const pdf = modal.querySelector("#lgOrderPdf");
    actions.insertBefore(button, pdf || actions.firstChild);
    button.addEventListener("click", () => createExcel(button));
    return true;
  }

  const observer = new MutationObserver(() => install());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  install();
})();
