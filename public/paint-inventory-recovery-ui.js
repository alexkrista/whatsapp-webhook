"use strict";
(function(){
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";

  async function api(url, opt={}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok:false, error:"Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function install(){
    if (document.getElementById("inventoryRecoveryBtn")) return true;
    const tools = document.querySelector("#tab-inventory .inventory-tools");
    if (!tools) return false;

    const button = document.createElement("button");
    button.type = "button";
    button.id = "inventoryRecoveryBtn";
    button.className = "btn";
    button.textContent = "LG Lager reparieren";
    button.title = "Baut den LG-Lagerstamm neu auf. EAN und letzter IST-Stand werden nach Möglichkeit gerettet. Mindest/Soll bleiben 0.";

    const status = document.createElement("span");
    status.id = "inventoryRecoveryStatus";
    status.className = "muted";
    status.style.fontSize = "12px";

    tools.appendChild(button);
    tools.appendChild(status);

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Prüfe Lagerdaten …";
      try {
        const preview = await api("/admin/api/paint/inventory/rebuild-preview");
        const c = preview.counts || {};
        if (!preview.safe) {
          throw new Error(`Abbruch: ${c.inventory || 0}/145 Lagerpositionen, ${c.colourants || 0}/15 Colourants.`);
        }
        const text = [
          "LG-Lager sauber neu aufbauen?",
          "",
          `Lagerpositionen: ${c.inventory}/145`,
          `Colourants: ${c.colourants}/15`,
          `EAN wiedergefunden: ${c.eanRecovered || 0}`,
          `IST aus Bewegungen gerettet: ${c.stockRecovered || 0}`,
          "",
          "Vorher wird automatisch ein Backup von articles.json angelegt.",
          "Mindest/Soll werden bewusst auf 0 gesetzt und können danach neu eingegeben werden."
        ].join("\n");
        if (!window.confirm(text)) {
          status.textContent = "Nicht ausgeführt.";
          return;
        }

        status.textContent = "Baue LG-Lager neu auf …";
        const result = await api("/admin/api/paint/inventory/rebuild", {
          method: "POST",
          body: JSON.stringify({ confirm: "RESET_LG_INVENTORY" }),
        });
        const r = result.counts || {};
        status.textContent = `Fertig: ${r.inventory || 0} Positionen · ${r.colourants || 0} Colourants · ${r.eanRecovered || 0} EAN.`;
        document.getElementById("inventoryReload")?.click();
        setTimeout(() => location.reload(), 500);
      } catch (error) {
        status.textContent = String(error?.message || error);
      } finally {
        button.disabled = false;
      }
    });

    return true;
  }

  if (!install()) {
    const observer = new MutationObserver(() => {
      if (install()) observer.disconnect();
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }
})();
