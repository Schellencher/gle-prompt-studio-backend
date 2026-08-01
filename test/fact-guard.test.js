"use strict";

const assert = require("assert");
const { createAccountProfile } = require("../src/profiles");
const {
  PROOF_MODE,
  buildFactOnlyOutput,
  applyStrictProfileFactGuard,
} = require("../src/fact-guard");

const account = { accountId: "acc_fact_guard", profiles: [] };
const profile = createAccountProfile(
  account,
  {
    name: "Magic Context Test",
    kind: "project",
    brandName: "TrailFold",
    proofFacts: [
      { label: "Produktname", value: "TrailFold 12" },
      { label: "Anschluss", value: "USB-C" },
      { label: "Lichtfarbe", value: "warmweiß" },
      { label: "Akkulaufzeit", value: "bis zu 12 Stunden" },
    ],
  },
  { nowTs: 1000 },
);

const safe = buildFactOnlyOutput(profile, { outLang: "DE" });
assert(safe.startsWith("TrailFold 12"));
assert(safe.includes("- Anschluss: USB-C"));
assert(safe.includes("- Lichtfarbe: warmweiß"));
assert(safe.includes("- Akkulaufzeit: bis zu 12 Stunden"));
assert(safe.endsWith("Details ansehen."));
assert(!safe.toLowerCase().includes("schnell"));
assert(!safe.toLowerCase().includes("robust"));
assert(!safe.toLowerCase().includes("wetter"));
assert(!safe.toLowerCase().includes("kompakt"));
assert(!safe.toLowerCase().includes("leicht"));

const hallucinatedModelOutput = `TrailFold 12\n\n- USB-C Anschluss für schnelles Laden\n- Robuste Bauweise für den Außeneinsatz\n- Kompakt und leicht\n- Wetterfest`;
const guarded = applyStrictProfileFactGuard({
  output: hallucinatedModelOutput,
  profile,
  isProductDescription: true,
  outLang: "DE",
});

assert.equal(guarded.proof.status, "PASSED");
assert.equal(guarded.proof.mode, PROOF_MODE);
assert.equal(guarded.proof.applied, true);
assert.equal(guarded.proof.action, "fact_only_render");
assert.equal(guarded.proof.factCount, 4);
assert.equal(guarded.proof.worldTruthVerified, false);
assert.equal(guarded.output, safe);
assert(!guarded.output.includes("schnelles Laden"));
assert(!guarded.output.includes("Robuste Bauweise"));

const noProfile = applyStrictProfileFactGuard({
  output: "Normaler Output",
  profile: null,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(noProfile.proof.status, "NOT_VERIFIED");
assert.equal(noProfile.proof.reason, "no_profile");
assert.equal(noProfile.output, "Normaler Output");

const unsupportedUseCase = applyStrictProfileFactGuard({
  output: "LinkedIn output",
  profile,
  isProductDescription: false,
  outLang: "DE",
});
assert.equal(unsupportedUseCase.proof.status, "NOT_VERIFIED");
assert.equal(unsupportedUseCase.proof.reason, "use_case_not_yet_supported");
assert.equal(unsupportedUseCase.output, "LinkedIn output");

console.log("GLE fact guard test passed");
