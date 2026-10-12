"use strict";

const { setTimeout: sleep } = require("node:timers/promises");
const DEFAULT_FALLBACK_URL = "https://photon.komoot.io/reverse";

function streetFromPhoton(body, point, maxMetres = 200) {
  const clean = value => typeof value === "string" ? value.trim().replace(/[,\r\n]+/g, " ").slice(0, 160) : "";
  const candidates = [];
  for (const feature of Array.isArray(body?.features) ? body.features : []) {
    const p = feature?.properties || {}, coord = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== "Point" || !Array.isArray(coord) || coord.length !== 2 ||
        !coord.every(value => typeof value === "number" && Number.isFinite(value))) continue;
    const street = clean(p.street) || (p.osm_key === "highway" ? clean(p.name) : "");
    const town = clean(p.city) || clean(p.town) || clean(p.village) || clean(p.locality);
    if (!street || !town) continue;
    const metres = Math.hypot((coord[1]-point.lat)*111195, (coord[0]-point.lng)*111195*Math.cos(point.lat*Math.PI/180));
    if (metres > maxMetres) continue;
    const postcode = clean(p.postcode);
    candidates.push({ metres, address: `${street}, ${[postcode,town].filter(Boolean).join(" ")}` });
  }
  candidates.sort((a,b) => a.metres-b.metres);
  return candidates[0]?.address || "";
}

function createStreetLookup({ primary, request = globalThis.fetch, fallbackUrl = DEFAULT_FALLBACK_URL,
    minIntervalMs = 5000, clock = Date.now, wait = sleep }) {
  const fallback = fallbackUrl ? new URL(fallbackUrl) : null;
  if (fallback && (fallback.protocol !== "https:" || fallback.username || fallback.password)) throw Error("Invalid GPS fallback URL");
  let tail = Promise.resolve(), lastRequestAt = null, blockedUntil = 0;
  const fallbackLookup = point => {
    const run = tail.catch(() => {}).then(async () => {
      const delay = lastRequestAt === null ? 0 : Math.max(0, minIntervalMs-(clock()-lastRequestAt));
      if (delay) await wait(delay);
      if (clock() < blockedUntil) throw Object.assign(Error("Fallback geocoder rate limited"), { status: 429 });
      lastRequestAt = clock();
      const url = new URL(fallback);
      url.searchParams.set("lat", String(point.lat)); url.searchParams.set("lon", String(point.lng));
      url.searchParams.set("radius", "0.2"); url.searchParams.set("limit", "5"); url.searchParams.set("lang", "de");
      // Only coordinates go to Photon. Never forward Traccar credentials or trip metadata.
      const response = await request(url.toString(), { headers: { Accept: "application/json",
        "User-Agent": "Kristine-Krisdrive/1.0 (+https://protokoll.krista.at)" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        if (response.status === 429) blockedUntil = clock() + Math.max(60000, (Number(response.headers?.get?.("retry-after")) || 60)*1000);
        throw Object.assign(Error("Fallback geocoder unavailable"), { status: response.status });
      }
      const address = streetFromPhoton(await response.json(), point);
      if (!address) throw Object.assign(Error("Fallback has no nearby street"), { code: "empty_address" });
      return { address, provider: "photon" };
    });
    tail = run;
    return run;
  };
  return async point => {
    try { return { address: await primary(point), provider: "traccar" }; }
    catch (error) {
      if (!fallback || [401,403].includes(error.status)) throw error;
      return fallbackLookup(point);
    }
  };
}

module.exports = { createStreetLookup, streetFromPhoton, DEFAULT_FALLBACK_URL };
