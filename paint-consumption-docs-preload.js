"use strict";

const express = require("express");
const previousSend = express.response.send;

express.response.send = function paintConsumptionDocsSend(body) {
  try {
    const reqPath = String(this.req?.path || this.req?.originalUrl || "").split("?")[0];
    if (reqPath === "/admin/paint" && (typeof body === "string" || Buffer.isBuffer(body))) {
      let html = Buffer.isBuffer(body) ? body.toString("utf8") : body;
      if (!html.includes("/public/paint-consumption-docs-ui.js")) {
        html = html.replace(
          "</body>",
          '<script src="/public/paint-consumption-docs-ui.js?v=20260825-1610"></script>\n</body>'
        );
      }
      if (!html.includes("/public/paint-material-docs-de.js")) {
        html = html.replace(
          "</body>",
          '<script src="/public/paint-material-docs-de.js?v=20260826-1310"></script>\n</body>'
        );
      }
      body = Buffer.isBuffer(body) ? Buffer.from(html, "utf8") : html;
    }
  } catch {}
  return previousSend.call(this, body);
};
