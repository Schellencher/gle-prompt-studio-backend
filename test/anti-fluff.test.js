"use strict";

const assert = require("assert");
const {
  ANTI_FLUFF_VERSION,
  getActiveBannedStems,
  findStemViolations,
  buildAntiFluffPromptBlock,
  buildAntiFluffRepairBlock,
  normalizeCtaLabel,
  forceNeutralCTA,
  hardStripHotStems,
} = require("../src/anti-fluff");

assert.equal(ANTI_FLUFF_VERSION, "anti-fluff-v1");

const overridden = getActiveBannedStems({ BOUNCER_BANNED_STEMS: "premium, hype" });
assert.ok(overridden.includes("premium"));
assert.ok(overridden.includes("hype"));
assert.ok(overridden.includes("tutmirleid"), "required refusal stem must survive env override");
assert.ok(overridden.includes("cannotcomply"), "required English refusal stem must survive env override");

const hits = findStemViolations(
  "Das ist sicher strategisch optimiert.",
  ["sicher", "strateg", "optimier"],
);
assert.deepEqual(hits, ["sicher", "strateg", "optimier"]);

const deBlock = buildAntiFluffPromptBlock({ outLang: "DE", stage: "generate" });
assert.ok(deBlock.includes("[GLE_ANTI_FLUFF_V1:generate]"));
assert.ok(deBlock.includes("Keine leeren Werbefloskeln"));
assert.ok(deBlock.includes("Anredeform beibehalten"));

const enBlock = buildAntiFluffPromptBlock({ outLang: "EN", stage: "generate" });
assert.ok(enBlock.includes("No empty marketing filler"));
assert.ok(enBlock.includes("Preserve the requested tone"));

const repairBlock = buildAntiFluffRepairBlock({
  outLang: "DE",
  hits: ["premium"],
  activeBannedStems: ["premium", "tutmirleid"],
});
assert.ok(repairBlock.includes("premium"));
assert.ok(repairBlock.includes("tutmirleid"));
assert.ok(repairBlock.includes("Betroffene Formulierungen"));

assert.equal(
  normalizeCtaLabel("5) CTA: Mehr erfahren.", "CTA-Zeile"),
  "5) CTA-Zeile: Mehr erfahren.",
);

const neutralDe = forceNeutralCTA("5) CTA: Jetzt kaufen!", "CTA:", "DE");
assert.ok(neutralDe.includes("CTA: Mehr erfahren."));
assert.ok(!/Warteliste/i.test(neutralDe), "generic CTA normalizer must not inject legacy waitlist copy");

const neutralEn = forceNeutralCTA("CTA: Buy now!", "CTA:", "EN");
assert.equal(neutralEn, "CTA: Learn more.");

const conservative = hardStripHotStems(
  "Sichere Strategie für Nutzer. Premium revolutionäre Qualität. Link in Bio",
);
assert.ok(conservative.includes("Sichere Strategie für Nutzer."));
assert.ok(!/premium/i.test(conservative));
assert.ok(!/revolution/i.test(conservative));
assert.ok(!/link\s+in\s+bio/i.test(conservative));

console.log("GLE anti-fluff central policy test passed");
