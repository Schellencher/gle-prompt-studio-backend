"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const generateStart = source.indexOf('app.post("/api/generate"');
assert.ok(generateStart >= 0, "generate route missing");
const generateEnd = source.indexOf('// --------------------\n// Test endpoint', generateStart);
const generateRoute = source.slice(generateStart, generateEnd > generateStart ? generateEnd : undefined);

for (const legacyAssignment of [
  "output = buildProductDescriptionFallback",
  "output = buildEmailFallback",
  "output = buildBlogFallback",
  "output = buildShortVideoFallback",
  "output = buildLinkedInFallback",
]) {
  assert.ok(
    !generateRoute.includes(legacyAssignment),
    `legacy active fallback still present: ${legacyAssignment}`,
  );
}

assert.ok(
  generateRoute.includes('hits: ["structural_format"]'),
  "structural repair is not routed through the use-case-aware repair prompt",
);

const socialStart = source.indexOf("function buildSocialFallback");
const socialEnd = source.indexOf("// --------------------\n// Landingpage / SaaS structured output helpers", socialStart);
assert.ok(socialStart >= 0 && socialEnd > socialStart, "social fallback block missing");
const socialFallback = source.slice(socialStart, socialEnd);

for (const leakedDemoTerm of [
  "GLE Prompt Studio",
  "Solopreneur",
  "waitlist",
  "Warteliste",
  "19.99",
  "19,99",
  "Early Access",
]) {
  assert.ok(
    !socialFallback.includes(leakedDemoTerm),
    `social fallback still contains demo term: ${leakedDemoTerm}`,
  );
}

assert.ok(
  source.includes("Erfinde keine Marken, Produktnamen, Zielgruppen, Preise"),
  "anti-invention rule missing from master prompt",
);

console.log("GLE topic fallback regression test passed");
