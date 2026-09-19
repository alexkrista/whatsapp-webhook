"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

async function launchTestBrowser(options = {}) {
  const explicitExecutable = String(process.env.TEST_BROWSER_EXECUTABLE || "").trim();
  const explicitChannel = String(process.env.TEST_BROWSER_CHANNEL || "").trim();

  if (explicitExecutable) {
    return chromium.launch({ ...options, channel: undefined, executablePath: explicitExecutable });
  }
  if (explicitChannel) return chromium.launch({ ...options, channel: explicitChannel });

  if (process.platform === "linux") {
    let serverlessChromium;
    try {
      const imported = require("@sparticuz/chromium");
      serverlessChromium = imported.default || imported;
      let executablePath;
      try {
        executablePath = await serverlessChromium.executablePath();
      } catch (error) {
        // Some container filesystems cannot restore ownership from fonts.tar,
        // although the independent Chromium archive was extracted correctly.
        const extracted = path.join(os.tmpdir(), "chromium");
        if (!fs.existsSync(extracted)) throw error;
        executablePath = extracted;
      }
      return chromium.launch({
        ...options,
        channel: undefined,
        executablePath,
        args: [...(serverlessChromium.args || []), ...(options.args || [])],
      });
    } catch (serverlessError) {
      try {
        return await chromium.launch({ ...options, channel: "chrome" });
      } catch (chromeError) {
        chromeError.cause = serverlessError;
        throw chromeError;
      }
    }
  }

  return chromium.launch({ ...options, channel: "chrome" });
}

module.exports = { launchTestBrowser };
