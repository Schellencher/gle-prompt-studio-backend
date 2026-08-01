"use strict";

const crypto = require("crypto");

function createRequestId(prefix = "gle") {
  const stamp = Date.now().toString(36);
  const entropy = crypto.randomBytes(8).toString("hex");
  return `${prefix}_${stamp}_${entropy}`;
}

module.exports = { createRequestId };
