"use strict";

const express = require("express");
const originalSend = express.response.send;

express.response.send = function paintLiveBrowserFixSend(body) {
  try {
    const reqPath = String(this.req?.path || this.req?.originalUrl || "").split("?")[0];
    if (reqPath === "/admin/paint" && (typeof body === "string" || Buffer.isBuffer(body))) {
      let html = Buffer.isBuffer(body) ? body.toString("utf8") : body;
      if (!html.includes("/public/paint-live-result-normalizer.js")) {
        html = html.replace(
          "</body>",
          '<script src="/public/paint-live-result-normalizer.js?v=20260825-0825"></script>\n</body>'
        );
        body = Buffer.isBuffer(body) ? Buffer.from(html, "utf8") : html;
      }
    }
  } catch {}
  return originalSend.call(this, body);
};
