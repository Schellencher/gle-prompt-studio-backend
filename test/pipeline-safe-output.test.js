"use strict";

const assert = require("node:assert/strict");
const {
  buildPipelineSafeOutput,
} = require("../src/pipeline-safe-output");

const profile = {
  proofFacts: [
    {
      id: "fact_name",
      label: "Produktname",
      value: "TrailFold 12",
      status: "approved",
    },
    {
      id: "fact_port",
      label: "Anschluss",
      value: "USB-C",
      status: "approved",
    },
    {
      id: "fact_light",
      label: "Lichtfarbe",
      value: "warmweiß",
      status: "approved",
    },
    {
      id: "fact_battery",
      label: "Akkulaufzeit",
      value: "bis zu 12 Stunden",
      status: "approved",
    },
  ],
};

const social = buildPipelineSafeOutput({
  step: { id: "social" },
  profile,
  outLang: "DE",
});

const linkedin = buildPipelineSafeOutput({
  step: { id: "linkedin" },
  profile,
  outLang: "DE",
});

const email = buildPipelineSafeOutput({
  step: { id: "email" },
  profile,
  outLang: "DE",
});

assert.equal(
  social.split("\n").filter((line) => line.trim()).length,
  7,
);
assert.match(social, /• USB-C-Anschluss/);

assert.match(
  linkedin,
  /TrailFold 12 hat einen USB-C-Anschluss\./,
);
assert.doesNotMatch(linkedin, /• USB-C-Anschluss/);

assert.match(email, /^Betreff:/);
assert.match(email, /Hallo,/);
assert.match(
  email,
  /TrailFold 12 hat einen USB-C-Anschluss\. Die Lichtfarbe ist warmweiß\./,
);
assert.doesNotMatch(email, /• USB-C-Anschluss/);

assert.notEqual(social, linkedin);
assert.notEqual(linkedin, email);
assert.notEqual(social, email);

assert.equal(
  buildPipelineSafeOutput({
    step: { id: "social" },
    profile: null,
  }),
  "",
);

console.log("GLE pipeline safe output test passed");
