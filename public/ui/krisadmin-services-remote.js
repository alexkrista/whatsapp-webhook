"use strict";

(() => {
  const VERSION = "2026-08-27-remote1";
  const LOCAL = "http://127.0.0.1:8765";
  const REMOTE = "https://pc-alex02.tail610122.ts.net/service-manager";
  const originalFetch = window.fetch.bind(window);

  function rewritten(input, init = {}) {
    const raw = typeof input === "string" ? input : String(input?.url || "");
    if (!raw.startsWith(LOCAL)) return null;
    const url = new URL(raw);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined) || {});
    // Der Brain-/Tailscale-Zugang ist bereits die Sicherheitsgrenze. Den Cloud-
    // Admin-Token schicken wir nicht quer ueber Origins; der Brain-Proxy setzt ihn
    // intern nur zum lokalen Manager.
    headers.delete("X-Krista-Admin-Token");
    const method = String(init.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    if (method === "POST" && headers.get("Content-Type")?.includes("application/json")) {
      // text/plain ist CORS-safelisted. Der Brain-Proxy liest den JSON-Text trotzdem.
      headers.set("Content-Type", "text/plain;charset=UTF-8");
    }
    return {
      url: REMOTE + url.pathname + url.search,
      options: { ...init, method, headers, credentials: "include", mode: "cors", cache: "no-store" },
    };
  }

  window.fetch = function kristaServicesRemoteFetch(input, init) {
    const hit = rewritten(input, init || {});
    return hit ? originalFetch(hit.url, hit.options) : originalFetch(input, init);
  };

  async function startManager(button) {
    if (button) {
      button.disabled = true;
      button.textContent = "Startet …";
    }
    try {
      const response = await originalFetch(REMOTE + "/start", {
        method: "POST",
        credentials: "include",
        mode: "cors",
        cache: "no-store",
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text || "{}"); } catch {}
      if (!response.ok || !data?.ok) throw new Error(data?.error || text || `HTTP ${response.status}`);
      if (button) button.textContent = "✓ gestartet";
      setTimeout(() => window.KrisadminServices?.load?.(), 800);
      setTimeout(() => window.KrisadminServices?.load?.(), 2200);
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = "▶ Dienstemanager starten";
      }
      alert("Dienstemanager konnte nicht gestartet werden: " + String(error?.message || error));
    }
  }

  function enhanceOffline() {
    const content = document.getElementById("kristaServicesContent");
    if (!content || !/Dienstemanager ist nicht erreichbar|Failed to fetch/i.test(content.textContent || "")) return;
    if (content.querySelector("[data-krista-manager-start]")) return;

    const wrap = document.createElement("div");
    wrap.style.marginTop = "14px";
    wrap.style.display = "flex";
    wrap.style.gap = "8px";
    wrap.style.flexWrap = "wrap";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "start";
    button.dataset.kristaManagerStart = "1";
    button.textContent = "▶ Dienstemanager starten";
    button.style.background = "#24733b";
    button.style.borderColor = "#24733b";
    button.style.color = "#fff";
    button.style.fontWeight = "850";
    button.onclick = () => startManager(button);

    const hint = document.createElement("span");
    hint.className = "ksvc-detail";
    hint.style.alignSelf = "center";
    hint.textContent = "über Firmen-PC / Tailscale";
    wrap.append(button, hint);
    content.appendChild(wrap);
  }

  const observer = new MutationObserver(enhanceOffline);
  function boot() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    enhanceOffline();
    console.info("KRISTA Dienste Remote", VERSION);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
