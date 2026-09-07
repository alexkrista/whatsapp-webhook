"use strict";

const DEFAULT_BASE_URL = "https://providersupportdata.cloud-cfg.com/v1";
const TOKEN_REUSE_MS = 4 * 60 * 1000;

class NfonApiError extends Error {
  constructor(message, { status = 0, requestId = "", body = "" } = {}) {
    super(message);
    this.name = "NfonApiError";
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

function required(value, name) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error(`${name} fehlt`);
  return clean;
}

function dialNumber(value, name) {
  const raw = required(value, name);
  const compact = raw.replace(/[\s()./-]/g, "");
  const withoutPrefix = compact.startsWith("+")
    ? compact.slice(1)
    : compact.startsWith("00")
      ? compact.slice(2)
      : compact;
  if (!/^\d+$/.test(withoutPrefix)) throw new Error(`${name} ist keine gültige Telefonnummer`);
  return withoutPrefix;
}

async function responseBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try { return JSON.parse(text); } catch { return text; }
}

function errorBody(value) {
  if (typeof value === "string") return value.slice(0, 1000);
  try { return JSON.stringify(value).slice(0, 1000); } catch { return ""; }
}

async function* parseSse(body) {
  if (!body || typeof body.getReader !== "function") throw new Error("NFON-Antwort enthält keinen SSE-Datenstrom");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n")
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try { yield JSON.parse(data); } catch { yield { raw: data }; }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

class NfonCtiClient {
  constructor(options = {}) {
    this.username = String(options.username ?? process.env.NFON_API_USERNAME ?? "").trim();
    this.password = String(options.password ?? process.env.NFON_API_PASSWORD ?? "").trim();
    this.kAccount = String(options.kAccount ?? process.env.NFON_K_ACCOUNT ?? "").trim();
    this.baseUrl = String(options.baseUrl ?? process.env.NFON_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.appName = String(options.appName ?? "kristine").trim() || "kristine";
    this.appVersion = String(options.appVersion ?? process.env.npm_package_version ?? "2.0.0").trim() || "2.0.0";
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.tokens = null;
    this.tokenUsableUntil = 0;
    if (typeof this.fetch !== "function") throw new Error("fetch ist nicht verfügbar");
  }

  configured() {
    return Boolean(this.username && this.password && this.kAccount);
  }

  userAgent() {
    return `${this.appName}/${this.appVersion} (${this.kAccount || "K-Account-fehlt"})`;
  }

  async authenticate({ force = false } = {}) {
    if (!this.configured()) throw new Error("NFON_API_USERNAME, NFON_API_PASSWORD oder NFON_K_ACCOUNT fehlt");
    if (!force && this.tokens?.accessToken && this.now() < this.tokenUsableUntil) return this.tokens.accessToken;

    if (!force && this.tokens?.refreshToken) {
      const refreshed = await this.#tokenRequest("PUT", this.tokens.refreshToken).catch(() => null);
      if (refreshed) return refreshed;
    }
    return this.#tokenRequest("POST");
  }

  async #tokenRequest(method, refreshToken = "") {
    const headers = { Accept: "application/json", "User-Agent": this.userAgent() };
    const options = { method, headers };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify({ username: this.username, password: this.password });
    } else {
      headers.Authorization = `Bearer ${refreshToken}`;
    }
    const response = await this.fetch(`${this.baseUrl}/login`, options);
    const body = await responseBody(response);
    if (!response.ok) throw this.#apiError("NFON-Anmeldung fehlgeschlagen", response, body);
    const accessToken = String(body?.["access-token"] || "").trim();
    const nextRefreshToken = String(body?.["refresh-token"] || "").trim();
    if (!accessToken) throw new NfonApiError("NFON-Anmeldung lieferte keinen Access-Token");
    this.tokens = { accessToken, refreshToken: nextRefreshToken };
    this.tokenUsableUntil = this.now() + TOKEN_REUSE_MS;
    return accessToken;
  }

  #apiError(message, response, body) {
    return new NfonApiError(message, {
      status: Number(response?.status || 0),
      requestId: String(response?.headers?.get?.("x-request-id") || ""),
      body: errorBody(body),
    });
  }

  async #request(pathname, options = {}, retry = true) {
    const accessToken = await this.authenticate();
    const headers = {
      Accept: "application/json",
      "User-Agent": this.userAgent(),
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    };
    const response = await this.fetch(`${this.baseUrl}${pathname}`, { ...options, headers });
    if (response.status === 401 && retry) {
      this.tokens = null;
      this.tokenUsableUntil = 0;
      await this.authenticate({ force: true });
      return this.#request(pathname, options, false);
    }
    if (!response.ok) {
      const body = await responseBody(response);
      throw this.#apiError(`NFON-Anfrage fehlgeschlagen (${options.method || "GET"} ${pathname})`, response, body);
    }
    return response;
  }

  async getPhoneExtensions() {
    return responseBody(await this.#request("/extensions/phone/data"));
  }

  async getStates(extensions = []) {
    const query = new URLSearchParams();
    for (const extension of extensions) query.append("extension", required(extension, "Nebenstelle"));
    const suffix = query.size ? `?${query}` : "";
    return responseBody(await this.#request(`/extensions/phone/states${suffix}`, {
      headers: { Accept: "application/json" },
    }));
  }

  async *streamStates({ signal } = {}) {
    const response = await this.#request("/extensions/phone/states", {
      headers: { Accept: "text/event-stream" }, signal,
    });
    yield* parseSse(response.body);
  }

  async originateCall({ caller, callee, extension, callerContext, calleeContext = "global", timeout = 20, signal } = {}) {
    const safeTimeout = Math.max(1, Math.min(120, Math.round(Number(timeout) || 20)));
    const payload = {
      caller: dialNumber(caller, "Anrufer"),
      caller_context: String(callerContext || this.kAccount || "").trim(),
      callee: dialNumber(callee, "Zielnummer"),
      callee_context: String(calleeContext || "global").trim(),
      extension: required(extension || caller, "Nebenstelle"),
      timeout: safeTimeout,
    };
    const response = await this.#request("/extensions/phone/calls", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    return responseBody(response);
  }

  async cancelCall(uuid) {
    const id = required(uuid, "Anruf-UUID");
    if (!/^[\w-]{36}$/.test(id)) throw new Error("Anruf-UUID ist ungültig");
    await this.#request(`/extensions/phone/calls/${encodeURIComponent(id)}`, { method: "DELETE" });
    return true;
  }

  async *streamCallEvents({ signal } = {}) {
    const response = await this.#request("/extensions/phone/calls", {
      headers: { Accept: "text/event-stream" }, signal,
    });
    yield* parseSse(response.body);
  }
}

module.exports = { NfonCtiClient, NfonApiError, dialNumber, parseSse };
