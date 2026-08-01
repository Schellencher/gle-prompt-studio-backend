"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

class GatewayLogger {
  constructor({ dataDir, fileName = "gle-provider-usage.jsonl" }) {
    this.filePath = path.join(dataDir, fileName);
    ensureDir(dataDir);
  }

  async write(record) {
    const line = JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      ...record,
    });
    await fs.promises.appendFile(this.filePath, `${line}\n`, "utf8");
  }
}

module.exports = { GatewayLogger, sha256 };
