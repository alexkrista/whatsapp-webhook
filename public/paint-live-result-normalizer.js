(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);

  function normalizeLiveResult(payload) {
    if (!payload || payload.status !== "done") return payload;
    const value = payload.result;

    if (value === null || value === undefined) {
      payload.result = [];
      return payload;
    }
    if (Array.isArray(value)) return payload;
    if (typeof value !== "object") return payload;

    // Produktantwort bleibt ein Objekt: { color, products, live }.
    if (Array.isArray(value.products) || value.color) return payload;

    // Falls ein Wrapper geliefert wird, dessen Inhalt bereits eine Liste ist.
    if (Array.isArray(value.items)) {
      payload.result = value.items;
      return payload;
    }
    if (Array.isArray(value.value)) {
      payload.result = value.value;
      return payload;
    }
    if (Array.isArray(value.results)) {
      payload.result = value.results;
      return payload;
    }

    // Innovatint/PowerShell entpackt bei genau EINEM Treffer die Liste zu
    // einem einzelnen Objekt. Fuer die Farbsuche muss es trotzdem eine Liste sein.
    if (value.id !== undefined || value.code !== undefined || value.uniqueCode !== undefined) {
      payload.result = [value];
    }
    return payload;
  }

  window.fetch = async function(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (!url.includes("/admin/api/paint/live/request/")) return response;
      const contentType = String(response.headers.get("content-type") || "");
      if (!contentType.includes("application/json")) return response;

      const clone = response.clone();
      const payload = normalizeLiveResult(await clone.json());
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
})();
