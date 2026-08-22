"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";

  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(Number(value || 0));
  const pieces = value => Number(value || 0).toLocaleString("de-AT", { maximumFractionDigits: 3 });

  async function api(url, options = {}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || body.ok === false) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.body = body;
      throw error;
    }
    return body;
  }

  function statusText(order) {
    if (!order) return "Noch keine tatsächlich gesendete Bestellung hinterlegt.";
    const source = order.source === "reimported_xlsx" ? "Excel eingelesen" : "unverändert übernommen";
    return `Gesendet: ${order.id} · ${order.positionCount} Pos. · ${pieces(order.pieces)} Stk · ${money(order.total)} · ${source}`;
  }

  function setMessage(text, strong = false) {
    const el = document.getElementById("lgSentOrderMessage");
    if (!el) return;
    el.textContent = text;
    el.style.fontWeight = strong ? "800" : "600";
  }

  async function loadStatus() {
    try {
      const data = await api("/admin/api/paint/sent-orders/status");
      setMessage(statusText(data.latest), !!data.latest);
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function ensureOrderSaved() {
    const save = document.getElementById("lgOrderSave");
    const status = document.getElementById("lgOrderStatus");
    if (!save || !status) return;
    save.click();
    const start = Date.now();
    while (Date.now() - start < 9000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const text = String(status.textContent || "").trim();
      if (/^(Gespeichert|Keine Änderungen)/i.test(text)) return;
      if (text && !/werden gespeichert|Bestellung wird geladen/i.test(text) && Date.now() - start > 400) {
        throw new Error(text);
      }
    }
    throw new Error("Bestellung konnte vor dem Übernehmen nicht sicher gespeichert werden");
  }

  async function markUnchanged() {
    try {
      await ensureOrderSaved();
      if (!window.confirm("Diese Bestellung wurde genau so an Little Greene gesendet?")) return;
      setMessage("Gesendete Bestellung wird festgeschrieben …");
      const data = await api("/admin/api/paint/sent-orders/unchanged", { method: "POST", body: "{}" });
      setMessage((data.duplicate ? "Bereits hinterlegt · " : "Gespeichert · ") + statusText(data.order), true);
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
      reader.onerror = () => reject(new Error("Excel konnte nicht gelesen werden"));
      reader.readAsDataURL(file);
    });
  }

  async function importSentFile(file) {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name || "")) {
      setMessage("Bitte die tatsächlich gesendete Little-Greene-Excel auswählen.", true);
      return;
    }
    try {
      setMessage("Gesendete Excel wird geprüft …");
      const base64 = await fileToBase64(file);
      const data = await api("/admin/api/paint/sent-orders/import", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, base64 }),
      });
      const q = data.order?.quantityChanges?.length || 0;
      const p = data.order?.priceChanges?.length || 0;
      let suffix = q ? ` · ${q} Mengenänderung${q === 1 ? "" : "en"} erkannt` : " · Mengen unverändert";
      if (p) suffix += ` · ${p} Preisabweichung${p === 1 ? "" : "en"} ⚠`;
      setMessage((data.duplicate ? "Bereits hinterlegt · " : "Übernommen · ") + statusText(data.order) + suffix, true);
    } catch (error) {
      const unknown = error.body?.unknown;
      setMessage(Array.isArray(unknown) && unknown.length ? `${error.message}: ${unknown.slice(0, 4).join(", ")}` : error.message, true);
    }
  }

  function installStyle() {
    if (document.getElementById("lgSentOrderStyle")) return;
    const style = document.createElement("style");
    style.id = "lgSentOrderStyle";
    style.textContent = `
      .lg-sent-order{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:9px 18px;border-bottom:1px solid var(--line);background:#fafbf9}
      .lg-sent-order-label{font-size:12px;font-weight:900;color:#4d5a50}.lg-sent-order-message{font-size:12px;color:#59635b;flex:1;min-width:220px}
      .lg-sent-order .btn{padding:7px 10px;font-size:12px}.lg-sent-order.drop{outline:2px dashed #236748;outline-offset:-4px;background:#eef7f0}
      @media(max-width:850px){.lg-sent-order{padding:9px 12px}.lg-sent-order-message{order:3;flex-basis:100%}.lg-sent-order .btn{flex:1}}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    const modal = document.getElementById("lgOrderReviewModal");
    const summary = document.getElementById("lgOrderSummary");
    if (!modal || !summary || document.getElementById("lgSentOrderBar")) return;
    installStyle();

    const bar = document.createElement("div");
    bar.id = "lgSentOrderBar";
    bar.className = "lg-sent-order";
    bar.innerHTML = `
      <span class="lg-sent-order-label">Tatsächlich gesendet</span>
      <button id="lgSentUnchanged" class="btn" type="button">Unverändert gesendet</button>
      <button id="lgSentImport" class="btn" type="button">Geänderte Excel einlesen</button>
      <input id="lgSentFile" type="file" accept=".xlsx,.xls" hidden>
      <span id="lgSentOrderMessage" class="lg-sent-order-message"></span>`;
    summary.insertAdjacentElement("afterend", bar);

    const input = bar.querySelector("#lgSentFile");
    bar.querySelector("#lgSentUnchanged").onclick = markUnchanged;
    bar.querySelector("#lgSentImport").onclick = () => { input.value = ""; input.click(); };
    input.onchange = () => importSentFile(input.files?.[0]);
    bar.addEventListener("dragover", event => { event.preventDefault(); bar.classList.add("drop"); });
    bar.addEventListener("dragleave", () => bar.classList.remove("drop"));
    bar.addEventListener("drop", event => {
      event.preventDefault();
      bar.classList.remove("drop");
      importSentFile(event.dataTransfer?.files?.[0]);
    });
    loadStatus();
  }

  const observer = new MutationObserver(ensureUi);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureUi();
})();
