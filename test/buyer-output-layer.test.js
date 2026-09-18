"use strict";

const assert = require("node:assert/strict");
const {
  BuyerOutputError,
  DEFAULT_BANNED_STEMS,
  runInputPreflight,
  buildProtectedRegistry,
  buildBuyerPromptPackage,
  validateCandidateSchema,
  validateIssuedTokens,
  checkCandidateForIllegalBannedWords,
  restoreTokens,
  validateActionClosing,
  auditBuyerOutput,
  generateLandingpageCopy,
} = require("../src/buyer-output-layer");

function baseCandidate(overrides = {}) {
  return {
    heroHook: "Klare Fakten. Klarer Text.",
    problemAgitation: "Das vorhandene Ziel bleibt im Mittelpunkt.",
    solutionPitch: "Die gelieferten Angaben werden zu einem zusammenhängenden Text verbunden.",
    actionClosing: "Der nächste Schritt steht direkt darunter.",
    ...overrides,
  };
}

async function passJudge() {
  return { isFaithful: true };
}

function expectBuyerError(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof BuyerOutputError, true);
    assert.equal(error.code, code);
    return true;
  });
}

(async () => {
  assert.deepEqual(runInputPreflight({ cta: "Jetzt testen" }), { valid: true });

  expectBuyerError(
    () => runInputPreflight({ cta: "" }),
    "PREFLIGHT_REJECTED_MISSING_CTA",
  );

  expectBuyerError(
    () => runInputPreflight({ cta: "Jetzt testen", angebot: "⟦GLE:FAKE:LITERAL:0⟧" }),
    "PREFLIGHT_REJECTED_RESERVED_TOKEN_SYNTAX",
  );

  const protectedInput = {
    zielgruppe: "Marketingagenturen",
    angebot: "ProX",
    features: ["Agentur-Dashboard", "strukturierte Eingabe"],
    cta: "Chance nutzen",
  };

  const registry = buildProtectedRegistry(protectedInput, DEFAULT_BANNED_STEMS);
  assert.equal(typeof registry.requestId, "string");
  assert.equal(registry.requestId.length, 32);
  assert.equal("cta" in registry.tokenizedInput, false);
  assert.equal(registry.tokenMap.size, 2);
  assert.match(registry.tokenizedInput.zielgruppe, /^⟦GLE:[A-F0-9]{32}:LITERAL:\d+⟧$/);
  assert.match(registry.tokenizedInput.features[0], /^⟦GLE:[A-F0-9]{32}:LITERAL:\d+⟧$/);
  assert.equal(registry.tokenizedInput.angebot, "ProX");
  assert.equal(registry.tokenizedInput.features[1], "strukturierte Eingabe");

  const promptPackage = buildBuyerPromptPackage(protectedInput);
  assert.equal(promptPackage.userPayload.brief.cta, undefined);
  assert.equal(promptPackage.systemPrompt.includes("Marketingagenturen"), false);
  assert.equal(promptPackage.systemPrompt.includes("Chance nutzen"), false);
  assert.equal(
    promptPackage.userPayload.protectedLiterals.some((entry) => entry.value === "Marketingagenturen"),
    true,
  );

  assert.equal(validateCandidateSchema(baseCandidate()).valid, true);
  assert.equal(
    validateCandidateSchema({ ...baseCandidate(), exactCTA: "Jetzt testen" }).valid,
    false,
  );
  assert.equal(validateCandidateSchema({ ...baseCandidate(), heroHook: null }).valid, false);

  const issuedToken = [...registry.tokenMap.keys()][0];
  assert.equal(
    validateIssuedTokens(baseCandidate({ heroHook: `Für ${issuedToken}.` }), registry.tokenMap).valid,
    true,
  );

  const fakeToken = "⟦GLE:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:LITERAL:999⟧";
  const unauthorized = validateIssuedTokens(
    baseCandidate({ heroHook: `Für ${fakeToken}.` }),
    registry.tokenMap,
  );
  assert.equal(unauthorized.valid, false);
  assert.equal(unauthorized.violationType, "UNAUTHORIZED_TOKEN_GENERATION");

  const malformed = validateIssuedTokens(
    baseCandidate({ heroHook: "Für ⟦GLE:KAPUTT." }),
    registry.tokenMap,
  );
  assert.equal(malformed.valid, false);
  assert.equal(malformed.violationType, "MALFORMED_INTERNAL_TOKEN");

  const rawBanned = checkCandidateForIllegalBannedWords(
    baseCandidate({ heroHook: "Für Marketingagenturen." }),
  );
  assert.equal(rawBanned.valid, false);
  assert.equal(rawBanned.violationType, "BANNED_WORD_BREACH");

  const freeChance = checkCandidateForIllegalBannedWords(
    baseCandidate({ heroHook: "Das ist deine Chance." }),
  );
  assert.equal(freeChance.valid, false);

  const tokenizedCopy = checkCandidateForIllegalBannedWords(
    baseCandidate({ heroHook: `Für ${issuedToken}.` }),
  );
  assert.equal(tokenizedCopy.valid, true);

  const weirdToken = "⟦GLE:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:LITERAL:0⟧";
  const weirdMap = new Map([[weirdToken, 'Marke "A\\B"\nZweite Zeile']]);
  const restored = restoreTokens(
    baseCandidate({ heroHook: `Über ${weirdToken}.` }),
    weirdMap,
  );
  assert.equal(restored.heroHook, 'Über Marke "A\\B"\nZweite Zeile.');

  assert.equal(
    validateActionClosing("Der nächste Schritt steht direkt darunter.", "Jetzt testen").valid,
    true,
  );
  assert.equal(validateActionClosing("Jetzt testen", "Jetzt testen").valid, false);
  assert.equal(validateActionClosing("Starte jetzt.", "Mehr erfahren").valid, false);

  const noJudge = await auditBuyerOutput(
    { ziel: "Social-Media-Beiträge erstellen", cta: "Jetzt testen" },
    new Map(),
    baseCandidate(),
  );
  assert.equal(noJudge.finalOutputVerified, false);
  assert.equal(noJudge.publicOutput, null);
  assert.equal(noJudge.auditLog.violations[0].code, "FIDELITY_VALIDATOR_UNAVAILABLE");

  const judgeCrash = await auditBuyerOutput(
    { ziel: "Social-Media-Beiträge erstellen", cta: "Jetzt testen" },
    new Map(),
    baseCandidate(),
    { nliValidator: async () => { throw new Error("judge down"); } },
  );
  assert.equal(judgeCrash.finalOutputVerified, false);
  assert.equal(judgeCrash.publicOutput, null);
  assert.equal(judgeCrash.auditLog.violations[0].code, "FIDELITY_VALIDATOR_ERROR");

  const hallucinatedPain = await auditBuyerOutput(
    { zielgruppe: "Solo-Selbstständige", ziel: "Social-Media-Beiträge erstellen", cta: "Jetzt testen" },
    new Map(),
    baseCandidate({
      heroHook: "Genug davon, stundenlang vor leeren Social-Media-Posts zu sitzen?",
      problemAgitation: "Jeden Abend kostet dich die Suche nach Ideen wertvolle Zeit.",
    }),
    {
      nliValidator: async () => ({
        isFaithful: false,
        violationType: "FACT_BREACH_HALLUCINATED_PAIN",
      }),
    },
  );
  assert.equal(hallucinatedPain.finalOutputVerified, false);
  assert.equal(hallucinatedPain.publicOutput, null);
  assert.equal(
    hallucinatedPain.auditLog.violations[0].code,
    "FACT_BREACH_HALLUCINATED_PAIN",
  );

  const impliedClaim = await auditBuyerOutput(
    { features: ["atmungsaktive Netzrückenlehne"], cta: "Jetzt entdecken" },
    new Map(),
    baseCandidate({ solutionPitch: "Die atmungsaktive Netzrückenlehne sorgt für weniger Schwitzen." }),
    {
      nliValidator: async () => ({
        isFaithful: false,
        violationType: "FACT_BREACH_IMPLIED_CLAIM",
      }),
    },
  );
  assert.equal(impliedClaim.finalOutputVerified, false);
  assert.equal(impliedClaim.publicOutput, null);
  assert.equal(impliedClaim.auditLog.violations[0].code, "FACT_BREACH_IMPLIED_CLAIM");

  const goodRegistry = buildProtectedRegistry({
    zielgruppe: "Marketingagenturen",
    angebot: "ProX",
    cta: "Chance nutzen",
  });
  const targetToken = goodRegistry.tokenizedInput.zielgruppe;
  const verified = await auditBuyerOutput(
    { zielgruppe: "Marketingagenturen", angebot: "ProX", cta: "Chance nutzen" },
    goodRegistry.tokenMap,
    baseCandidate({ heroHook: `Für ${targetToken}: ProX im Fokus.` }),
    { nliValidator: passJudge },
  );
  assert.equal(verified.finalOutputVerified, true);
  assert.equal(verified.auditLog.status, "PASSED");
  assert.equal(verified.publicOutput.heroHook, "Für Marketingagenturen: ProX im Fokus.");
  assert.equal(verified.publicOutput.exactCTA, "Chance nutzen");
  assert.equal(verified.candidate.heroHook.includes("Marketingagenturen"), false);

  let judgeWasCalled = false;
  const secondCta = await auditBuyerOutput(
    { angebot: "ProX", cta: "Jetzt testen" },
    new Map(),
    baseCandidate({ actionClosing: "Starte jetzt." }),
    {
      nliValidator: async () => {
        judgeWasCalled = true;
        return { isFaithful: true };
      },
    },
  );
  assert.equal(secondCta.finalOutputVerified, false);
  assert.equal(secondCta.publicOutput, null);
  assert.equal(secondCta.auditLog.violations[0].code, "SECONDARY_CTA_BREACH");
  assert.equal(judgeWasCalled, false);

  let seenPayload = null;
  const generated = await generateLandingpageCopy(
    { zielgruppe: "Solo-Selbstständige", angebot: "ProX", cta: "Jetzt testen" },
    {
      generateCandidate: async ({ userPayload }) => {
        seenPayload = userPayload;
        return baseCandidate();
      },
      nliValidator: passJudge,
    },
  );
  assert.equal(seenPayload.brief.cta, undefined);
  assert.equal(generated.finalOutputVerified, true);
  assert.equal(generated.publicOutput.exactCTA, "Jetzt testen");

  console.log("GLE buyer output zero-trust hardcore matrix passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
