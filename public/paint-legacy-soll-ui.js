"use strict";
(function(){
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const api = async (url, opt={}) => {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    });
    const data = await response.json().catch(() => ({ok:false,error:"Keine JSON-Antwort"}));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  };
  const base64 = file => new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  function install(){
    if (document.getElementById("legacySollImportBtn")) return true;
    const tools = document.querySelector("#tab-inventory .inventory-tools");
    if (!tools) return false;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx";
    input.id = "legacySollImportFile";
    input.hidden = true;

    const button = document.createElement("button");
    button.type = "button";
    button.id = "legacySollImportBtn";
    button.className = "btn";
    button.textContent = "Altes Excel → Soll übernehmen";
    button.title = "Übernimmt nur Mindest/Soll. Gezählt-Ist und Lagerbewegungen bleiben unverändert.";

    const status = document.createElement("span");
    status.id = "legacySollImportStatus";
    status.className = "muted";
    status.style.fontSize = "12px";

    tools.appendChild(input);
    tools.appendChild(button);
    tools.appendChild(status);

    button.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      button.disabled = true;
      status.textContent = "Sollwerte werden übernommen …";
      try {
        const data = await api("/admin/api/paint/inventory/import-legacy-soll", {
          method: "POST",
          body: JSON.stringify({ base64: await base64(file) }),
        });
        status.textContent = `Fertig: ${data.changed} Werte aktualisiert · ${data.matched} Positionen erkannt`;
        document.getElementById("inventoryReload")?.click();
      } catch (error) {
        status.textContent = String(error?.message || error);
      } finally {
        input.value = "";
        button.disabled = false;
      }
    });
    return true;
  }

  if (!install()) {
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    observer.observe(document.body, { childList:true, subtree:true });
  }
})();
