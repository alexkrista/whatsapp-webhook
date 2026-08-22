"use strict";

const fs = require("fs/promises");
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require(expressPath);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolish(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "on", "yes"].includes(text)) return true;
  if (["false", "off", "no"].includes(text)) return false;
  return null;
}

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const dataDir = process.env.DATA_DIR || "/var/data";
  const adminToken = String(process.env.ADMIN_TOKEN || "");
  const traccarBaseUrl = String(process.env.TRACCAR_BASE_URL || "").replace(/\/$/, "");
  const traccarToken = String(process.env.TRACCAR_TOKEN || "").trim();

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = String(req.headers["x-admin-token"] || req.query.token || "");
    if (token === adminToken) return true;
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function traccarGet(apiPath) {
    if (!traccarBaseUrl || !traccarToken) throw new Error("Traccar ist noch nicht vollständig konfiguriert.");
    const response = await fetch(`${traccarBaseUrl}${apiPath}`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${traccarToken}`,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Traccar ${response.status}: ${text.slice(0, 250)}`);
    return text ? JSON.parse(text) : [];
  }

  function statusFor({ tracking, device, position, session }) {
    if (!tracking) return "not_configured";
    if (!device) return "waiting_device";
    if (String(device.status || "").toLowerCase() === "offline") return "offline";
    const attrs = position?.attributes || {};
    const ignition = boolish(attrs.ignition);
    const speedKmh = Math.max(0, Number(position?.speed || 0) * 1.852);
    if (ignition === true && speedKmh >= 2) return "driving";
    if (ignition === true) return "ignition_on";
    if (session && !session.closedAt) return "active_session";
    if (position) return "parked";
    return "online";
  }

  app.get("/krisdrive", (req, res) => {
    const token = req.query.token ? `?token=${encodeURIComponent(String(req.query.token))}` : "";
    res.redirect(302, `/public/krisdrive.html${token}`);
  });

  app.get("/kristine/api/krisdrive/live", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const vehicleMasterPath = path.join(dataDir, "_system", "vehicles.json");
    const trackerConfigPath = path.join(dataDir, "_kristine", "vehicle-tracking", "tracker-config.json");
    const sessionsPath = path.join(dataDir, "_kristine", "vehicle-tracking", "sessions.json");

    try {
      const [masterRaw, configRaw, sessionsRaw] = await Promise.all([
        readJson(vehicleMasterPath, []),
        readJson(trackerConfigPath, []),
        readJson(sessionsPath, {}),
      ]);

      let devices = [];
      let positions = [];
      let traccarError = "";
      if (traccarBaseUrl && traccarToken) {
        try {
          [devices, positions] = await Promise.all([
            traccarGet("/api/devices"),
            traccarGet("/api/positions"),
          ]);
        } catch (error) {
          traccarError = String(error?.message || error);
        }
      } else {
        traccarError = "Traccar-Zugang in Render noch nicht vollständig gesetzt.";
      }

      const master = asArray(masterRaw);
      const config = asArray(configRaw);
      const sessions = sessionsRaw && typeof sessionsRaw === "object" && !Array.isArray(sessionsRaw) ? sessionsRaw : {};
      const deviceById = new Map(asArray(devices).map(row => [String(row.id), row]));
      const deviceByUniqueId = new Map(asArray(devices).map(row => [String(row.uniqueId || ""), row]));
      const positionByDeviceId = new Map(asArray(positions).map(row => [String(row.deviceId), row]));

      const rows = master.map(vehicle => {
        const vehicleId = String(vehicle.id || "");
        const tracking = config.find(item => String(item.vehicleId || "") === vehicleId) || null;
        const device = tracking
          ? deviceById.get(String(tracking.traccarDeviceId || "")) || deviceByUniqueId.get(String(tracking.trackerUniqueId || "")) || null
          : null;
        const position = device ? positionByDeviceId.get(String(device.id)) || null : null;
        const session = sessions[vehicleId] && !sessions[vehicleId].closedAt ? sessions[vehicleId] : null;
        const attrs = position?.attributes && typeof position.attributes === "object" ? position.attributes : {};
        const speedKmh = numberOrNull(position?.speed) === null ? null : Math.max(0, Number(position.speed) * 1.852);
        const ignition = boolish(attrs.ignition);
        const odometerRaw = attrs.totalDistance ?? attrs.totalMileage ?? attrs.odometer ?? null;
        const battery = attrs.batteryLevel ?? attrs.battery ?? attrs.power ?? null;
        const fuel = attrs.fuel ?? attrs.fuelLevel ?? null;
        const lastSeen = position?.fixTime || position?.deviceTime || position?.serverTime || device?.lastUpdate || null;
        return {
          vehicle: {
            id: vehicleId,
            label: String(vehicle.label || [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.plate || "Fahrzeug"),
            plate: String(vehicle.plate || ""),
            make: String(vehicle.make || ""),
            model: String(vehicle.model || ""),
            year: Number(vehicle.year || 0) || null,
          },
          tracking: tracking ? {
            trackerModel: String(tracking.trackerModel || "FMC250"),
            trackerUniqueId: String(tracking.trackerUniqueId || ""),
            traccarDeviceId: String(tracking.traccarDeviceId || ""),
            canEnabled: tracking.canEnabled !== false,
          } : null,
          device: device ? {
            id: device.id,
            name: String(device.name || ""),
            uniqueId: String(device.uniqueId || ""),
            status: String(device.status || ""),
            lastUpdate: device.lastUpdate || null,
          } : null,
          position: position ? {
            lat: numberOrNull(position.latitude),
            lng: numberOrNull(position.longitude),
            address: String(position.address || ""),
            speedKmh,
            course: numberOrNull(position.course),
            ignition,
            lastSeen,
            battery: numberOrNull(battery),
            fuel: numberOrNull(fuel),
            odometerRaw: numberOrNull(odometerRaw),
            attributes: attrs,
          } : null,
          driver: session?.driver || null,
          session: session ? {
            id: session.id,
            startedAt: session.startedAt,
            buzzerWanted: session.buzzerWanted === true,
            unresolvedDriver: session.unresolvedDriver === true,
          } : null,
          status: statusFor({ tracking, device, position, session }),
        };
      });

      res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        traccarConfigured: Boolean(traccarBaseUrl && traccarToken),
        traccarError,
        vehicleCount: rows.length,
        liveCount: rows.filter(row => row.position?.lat !== null && row.position?.lng !== null).length,
        vehicles: rows,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // KRISDRIVE erscheint als eigene KRISTA-Arbeitswelt, ohne die große topbar.js zu duplizieren.
  // Die Route liegt vor express.static und ergänzt die bestehende Datei beim Ausliefern.
  app.get("/public/ui/topbar.js", async (req, res, next) => {
    try {
      const file = path.join(process.cwd(), "public", "ui", "topbar.js");
      let source = await fs.readFile(file, "utf8");
      if (!source.includes('key: "krisdrive"')) {
        const anchor = '    { key: "kristine", label: "KRISTINE", icon: "✦", href: "/kristine#planning", subtitle: "Planung und Leitstand" },';
        source = source.replace(anchor, `${anchor}\n    { key: "krisdrive", label: "KRISDRIVE", icon: "🚐", href: "/krisdrive", subtitle: "Live-Fuhrpark, Fahrer und Fahrten" },`);
      }
      if (!source.includes('pathname.includes("/krisdrive")')) {
        const anchor = '    if (pathname.includes("kontrollzentrum")) return "kristower";';
        source = source.replace(anchor, `${anchor}\n    if (pathname.includes("/krisdrive")) return "krisdrive";`);
      }
      res.type("application/javascript").set("Cache-Control", "no-cache").send(source);
    } catch (error) {
      next();
    }
  });

  return app;
}

Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
