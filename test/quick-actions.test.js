"use strict";

const assert = require("assert");
const {
  QUICK_ACTIONS_VERSION,
  QuickActionError,
  normalizeQuickAction,
  validateQuickActionInput,
  buildQuickActionPrompt,
  buildQuickActionRepairPrompt,
  detectUseCaseFlags,
  assessQuickActionChange,
  applyActionAwareSafeVariant,
} = require("../src/quick-actions");
const { auditOutputAgainstFacts } = require("../src/fact-guard");

assert.equal(QUICK_ACTIONS_VERSION, "quick-actions-v1.1");
assert.equal(normalizeQuickAction("KÜRZEN"), "shorten");
assert.equal(normalizeQuickAction("structure"), "structure");
assert.equal(normalizeQuickAction("tone_switch"), "tone");
assert.equal(normalizeQuickAction("unknown"), "");

assert.throws(
  () => validateQuickActionInput({ currentOutput: "", actionType: "shorten" }),
  (err) => err instanceof QuickActionError && err.code === "missing_current_output",
);
assert.throws(
  () => validateQuickActionInput({ currentOutput: "Text", actionType: "magic" }),
  (err) => err instanceof QuickActionError && err.code === "invalid_action_type",
);

const prompt = buildQuickActionPrompt({
  currentOutput: "TrailFold 12 hat einen USB-C-Anschluss.",
  actionType: "headline",
  useCase: "Produktbeschreibung",
  tone: "Professionell",
  outLang: "DE",
  groundingPromptBlock: "[GROUNDING_TEST]",
});
assert.ok(prompt.includes("[GLE_QUICK_ACTIONS_V1_1:headline]"));
assert.ok(prompt.includes("FAKTEN-DECKEL"));
assert.ok(prompt.includes("[GLE_ANTI_FLUFF_V1:quick_action_headline]"));
assert.ok(prompt.includes("[GROUNDING_TEST]"));
assert.ok(prompt.includes("<CURRENT_OUTPUT>"));
assert.ok(prompt.includes("keine neue Eigenschaft"));

const tonePrompt = buildQuickActionPrompt({
  currentOutput: "USB-C.",
  actionType: "tone",
  targetTone: "Direkt",
  outLang: "DE",
});
assert.ok(tonePrompt.includes("Zielton = Direkt"));

const repair = buildQuickActionRepairPrompt({
  badOutput: "Premium Produkt.",
  sourceOutput: "USB-C-Anschluss.",
  actionType: "shorten",
  outLang: "DE",
  hits: ["premium"],
  activeBannedStems: ["premium"],
});
assert.ok(repair.includes("[GLE_QUICK_ACTION_REPAIR_V1_1:shorten]"));
assert.ok(repair.includes("premium"));
assert.ok(repair.includes("<SOURCE_OUTPUT>"));

const social = detectUseCaseFlags("Social Media Post");
assert.equal(social.isSocial, true);
assert.equal(social.isProductDescription, false);
const product = detectUseCaseFlags("Produktbeschreibung");
assert.equal(product.isProductDescription, true);

const socialSafe = [
  "TrailFold 12 in drei Fakten.",
  "Produktdetails, direkt auf den Punkt.",
  "• USB-C-Anschluss",
  "• Warmweißes Licht",
  "• Akkulaufzeit bis zu 12 Stunden",
  "Welcher Punkt interessiert dich am meisten?",
  "Details zu TrailFold 12 ansehen.",
].join("\n");

const unchangedShorten = assessQuickActionChange({
  sourceOutput: socialSafe,
  candidateOutput: socialSafe,
  actionType: "shorten",
});
assert.deepEqual(unchangedShorten, {
  changed: false,
  noOpReason: "already_compact",
});

const clearlyShorter = assessQuickActionChange({
  sourceOutput:
    "TrailFold 12 hat einen USB-C-Anschluss. Die Lichtfarbe ist warmweiß. Die Akkulaufzeit beträgt bis zu 12 Stunden. Weitere Produktdetails sind hier nochmals zusammengefasst.",
  candidateOutput:
    "TrailFold 12: USB-C-Anschluss, warmweißes Licht, Akkulaufzeit bis zu 12 Stunden.",
  actionType: "shorten",
});
assert.equal(clearlyShorter.changed, true);

const ctaVariant = applyActionAwareSafeVariant({
  output: socialSafe,
  actionType: "cta",
  useCase: "Social Media Post",
  outLang: "DE",
});
assert.ok(ctaVariant.endsWith("Mehr über TrailFold 12 erfahren."));
assert.equal(ctaVariant.split("\n").length, 7);

const headlineVariant = applyActionAwareSafeVariant({
  output: socialSafe,
  actionType: "headline",
  useCase: "Social Media Post",
  outLang: "DE",
});
assert.ok(headlineVariant.startsWith("Drei Fakten zu TrailFold 12."));
assert.equal(headlineVariant.split("\n").length, 7);

const trailFoldProfile = {
  id: "profile_test",
  version: 1,
  proofFacts: [
    { id: "fact_name", label: "Produktname", value: "TrailFold 12", status: "approved", version: 1 },
    { id: "fact_connector", label: "Anschluss", value: "USB-C", status: "approved", version: 1 },
    { id: "fact_light", label: "Lichtfarbe", value: "warmweiß", status: "approved", version: 1 },
    { id: "fact_runtime", label: "Akkulaufzeit", value: "bis zu 12 Stunden", status: "approved", version: 1 },
  ],
};

for (const candidate of [ctaVariant, headlineVariant]) {
  const audit = auditOutputAgainstFacts(candidate, trailFoldProfile);
  assert.equal(audit.rejectedClaimCount, 0);
  assert.ok(audit.verifiedBodyFactCount > 0);
}

console.log("GLE Quick Actions v1.1 policy test passed");
