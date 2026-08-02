"use strict";

const assert = require("assert");
const { createAccountProfile } = require("../src/profiles");
const {
  PROOF_MODE,
  buildNaturalFactOutput,
  auditOutputAgainstFacts,
  applyClaimAwareFactGuard,
} = require("../src/fact-guard");

const account = { accountId: "acc_fact_guard_v2", profiles: [] };
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

assert.equal(PROOF_MODE, "claim-aware-profile-facts-v2");

const safe = buildNaturalFactOutput(profile, { outLang: "DE" });
assert(safe.startsWith("TrailFold 12"));
assert(safe.includes("USB-C"));
assert(safe.includes("warmweiß"));
assert(safe.includes("bis zu 12 Stunden"));
assert(safe.endsWith("Details ansehen."));
assert(!safe.toLowerCase().includes("schnell"));
assert(!safe.toLowerCase().includes("robust"));
assert(!safe.toLowerCase().includes("wetter"));
assert(!safe.toLowerCase().includes("kompakt"));

const safeAudit = auditOutputAgainstFacts(safe, profile);
assert.equal(safeAudit.rejectedClaimCount, 0);
assert.equal(safeAudit.completeFactCoverage, true);
assert.equal(safeAudit.verifiedFactCount, 4);

const cleanNaturalModelOutput = `TrailFold 12\n\nTrailFold 12 bietet einen USB-C-Anschluss, warmweißes Licht und eine Akkulaufzeit von bis zu 12 Stunden.\n\nDetails ansehen.`;
const passed = applyClaimAwareFactGuard({
  output: cleanNaturalModelOutput,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(passed.proof.status, "PASSED");
assert.equal(passed.proof.mode, PROOF_MODE);
assert.equal(passed.proof.action, "model_output_verified");
assert.equal(passed.proof.rejectedClaimCount, 0);
assert.equal(passed.proof.verifiedFactCount, 4);
assert.equal(passed.proof.safeOutputApplied, false);
assert.equal(passed.output, cleanNaturalModelOutput);

const hallucinatedModelOutput = `TrailFold 12\n\n- USB-C Anschluss für schnelles Laden\n- Warmweißes Licht schafft eine angenehme Atmosphäre\n- Akkulaufzeit bis zu 12 Stunden\n- Robuste Bauweise für den Außeneinsatz\n- Kompakt und leicht für einfache Mitnahme\n\nDetails ansehen.`;
const reviewed = applyClaimAwareFactGuard({
  output: hallucinatedModelOutput,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(reviewed.proof.status, "SAFE_REWRITE");
assert.equal(reviewed.proof.mode, PROOF_MODE);
assert.equal(reviewed.proof.action, "safe_natural_rewrite");
assert.equal(reviewed.proof.reason, "unsupported_claims_detected");
assert(reviewed.proof.rejectedClaimCount >= 3);
assert.equal(reviewed.proof.safeOutputApplied, true);
assert.equal(reviewed.proof.humanReviewRequired, false);
assert.equal(reviewed.proof.finalOutputVerified, true);
assert.equal(reviewed.proof.verifiedFactCount, 4);
assert.equal(reviewed.output, safe);
assert(!reviewed.output.toLowerCase().includes("schnell"));
assert(!reviewed.output.toLowerCase().includes("robust"));
assert(!reviewed.output.toLowerCase().includes("wetter"));
assert(!reviewed.output.toLowerCase().includes("kompakt"));
assert(reviewed.proof.rejectedClaims.some((claim) => /schnell/i.test(claim.text)));

const wrongConnector = applyClaimAwareFactGuard({
  output: `TrailFold 12\n\nTrailFold 12 bietet einen USB-A-Anschluss, warmweißes Licht und eine Akkulaufzeit von bis zu 12 Stunden.`,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(wrongConnector.proof.status, "SAFE_REWRITE");
assert(wrongConnector.proof.rejectedClaimCount >= 1);

const inventedNumber = applyClaimAwareFactGuard({
  output: `TrailFold 12\n\nTrailFold 12 bietet USB-C und lädt in 2 Stunden.`,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(inventedNumber.proof.status, "SAFE_REWRITE");
assert(inventedNumber.proof.rejectedClaims.some((claim) => claim.reason === "unsupported_number"));

const incomplete = applyClaimAwareFactGuard({
  output: `TrailFold 12\n\nTrailFold 12 bietet einen USB-C-Anschluss.\n\nDetails ansehen.`,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(incomplete.proof.status, "SAFE_REWRITE");
assert.equal(incomplete.proof.reason, "incomplete_fact_coverage");
assert.equal(incomplete.output, safe);

const noProfile = applyClaimAwareFactGuard({
  output: "Normaler Output",
  profile: null,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(noProfile.proof.status, "NOT_VERIFIED");
assert.equal(noProfile.proof.reason, "no_profile");
assert.equal(noProfile.output, "Normaler Output");

const unsupportedUseCase = applyClaimAwareFactGuard({
  output: "LinkedIn output",
  profile,
  isProductDescription: false,
  outLang: "DE",
});
assert.equal(unsupportedUseCase.proof.status, "NOT_VERIFIED");
assert.equal(unsupportedUseCase.proof.reason, "use_case_not_yet_supported");
assert.equal(unsupportedUseCase.output, "LinkedIn output");

console.log("GLE Fact Guard v2 test passed");
