"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "gle-server-load-"));
process.env.DATA_DIR = tempData;
process.env.STRIPE_SECRET_KEY = "";
process.env.BETA_LOCK_ENABLED = "false";
process.env.PORT = "3999";

const routes = [];
const app = {
  post(route, ...handlers) { routes.push({ method: "POST", route, handlers }); },
  get(route, ...handlers) { routes.push({ method: "GET", route, handlers }); },
  put(route, ...handlers) { routes.push({ method: "PUT", route, handlers }); },
  delete(route, ...handlers) { routes.push({ method: "DELETE", route, handlers }); },
  use() {},
  listen(port, host, cb) { if (typeof cb === "function") cb(); return { close() {} }; },
};

function expressStub() { return app; }
expressStub.raw = () => (req, res, next) => next && next();
expressStub.json = () => (req, res, next) => next && next();

function corsStub() { return (req, res, next) => next && next(); }
class StripeStub {}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "dotenv") return { config() {} };
  if (request === "express") return expressStub;
  if (request === "cors") return corsStub;
  if (request === "stripe") return StripeStub;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../server.js");
} finally {
  Module._load = originalLoad;
}

assert.ok(routes.some((r) => r.method === "GET" && r.route === "/api/health"));
assert.ok(routes.some((r) => r.method === "POST" && r.route === "/api/generate"));
assert.ok(routes.some((r) => r.method === "POST" && r.route === "/api/transform"));
assert.ok(routes.some((r) => r.method === "POST" && r.route === "/api/pipeline"));
assert.ok(routes.some((r) => r.method === "POST" && r.route === "/api/test"));
assert.ok(routes.some((r) => r.method === "GET" && r.route === "/api/profiles"));
assert.ok(routes.some((r) => r.method === "GET" && r.route === "/api/profiles/:profileId"));
assert.ok(routes.some((r) => r.method === "POST" && r.route === "/api/profiles"));
assert.ok(routes.some((r) => r.method === "PUT" && r.route === "/api/profiles/:profileId"));
assert.ok(routes.some((r) => r.method === "DELETE" && r.route === "/api/profiles/:profileId"));
console.log("GLE server load smoke test passed");
