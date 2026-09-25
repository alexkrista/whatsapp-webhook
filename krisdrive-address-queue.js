"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// One consumer in the existing disk-backed web service. Jobs and successful
// results survive restarts; no browser, extra service or third-party key needed.
function createAddressQueue({ file, lookup, now = Date.now }) {
  let state, lock = Promise.resolve(), running;
  async function transaction(fn) {
    const task = lock.catch(() => {}).then(async () => {
      if (!state) {
        try { state = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; state = { version: 1, jobs: {} }; }
        if (state.version !== 1 || !state.jobs || typeof state.jobs !== "object" || Array.isArray(state.jobs)) {
          state = null; throw Error("Invalid address queue");
        }
      }
      const draft = structuredClone(state);
      const result = fn(draft);
      if (JSON.stringify(state) !== JSON.stringify(draft)) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(draft), { mode: 0o600 });
        await fs.rename(tmp, file);
        state = draft;
      }
      return result;
    });
    lock = task;
    return task;
  }
  async function enqueue(points) {
    return transaction(state => {
      const result = {};
      for (const [key, point] of points) {
        const job = state.jobs[key] ||= { point, createdAt: now(), attempts: 0, nextAttemptAt: 0 };
        result[key] = job.address || "";
      }
      return result;
    });
  }
  async function drain({ limit = 4, wanted, force = false, shouldRequest } = {}) {
    if (running) return running;
    running = (async () => {
      const jobs = await transaction(state => Object.entries(state.jobs)
        .filter(([key, job]) => !job.address && (!wanted || wanted.has(key)) && (force || job.nextAttemptAt <= now()))
        .sort((a, b) => a[1].attempts - b[1].attempts || a[1].nextAttemptAt - b[1].nextAttemptAt || a[1].createdAt - b[1].createdAt)
        .slice(0, limit));
      for (const [key, job] of jobs) {
        if (shouldRequest && !await shouldRequest(key)) continue;
        let address = "", error = "empty_response";
        try { address = await lookup(job.point); }
        catch (e) { error = ["empty_address", "address_format"].includes(e.code) ? e.code : e.name === "TimeoutError" ? "timeout" : Number.isInteger(e.status) ? `http_${e.status}` : "provider_unavailable"; }
        await transaction(state => {
          const current = state.jobs[key];
          current.attempts++; current.lastAttemptAt = now();
          if (address) { current.address = address; current.resolvedAt = now(); delete current.error; current.nextAttemptAt = 0; }
          else { current.error = error; current.nextAttemptAt = now() + Math.min(3600000, 60000 * 2 ** Math.min(current.attempts - 1, 6)); }
        });
      }
      return jobs.length;
    })();
    try { return await running; } finally { running = null; }
  }
  async function status(wanted) {
    return transaction(state => {
      const jobs = Object.entries(state.jobs).filter(([key]) => !wanted || wanted.has(key)).map(([, job]) => job);
      const pending = jobs.filter(job => !job.address), errors = {};
      for (const job of pending) if (job.error) errors[job.error] = (errors[job.error] || 0) + 1;
      return { pending: pending.length, resolved: jobs.length - pending.length, errors,
        lastAttemptAt: Math.max(0, ...jobs.map(job => job.lastAttemptAt || 0)),
        nextAttemptAt: pending.length ? Math.min(...pending.map(job => job.nextAttemptAt || 0)) : null };
    });
  }
  return { enqueue, drain, status };
}

module.exports = { createAddressQueue };
