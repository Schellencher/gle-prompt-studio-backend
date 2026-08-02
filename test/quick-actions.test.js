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
} = require("../src/quick-actions");

assert.equal(QUICK_ACTIONS_VERSION, "quick-actions-v1");
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
assert.ok(prompt.includes("[GLE_QUICK_ACTIONS_V1:headline]"));
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
assert.ok(repair.includes("[GLE_QUICK_ACTION_REPAIR_V1:shorten]"));
assert.ok(repair.includes("premium"));
assert.ok(repair.includes("<SOURCE_OUTPUT>"));

const social = detectUseCaseFlags("Social Media Post");
assert.equal(social.isSocial, true);
assert.equal(social.isProductDescription, false);
const product = detectUseCaseFlags("Produktbeschreibung");
assert.equal(product.isProductDescription, true);

console.log("GLE Quick Actions v1 policy test passed");
