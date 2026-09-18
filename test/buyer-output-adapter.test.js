"use strict";

const assert = require("node:assert/strict");
const {
  BuyerOutputError,
} = require("../src/buyer-output-layer");
const {
  parseStructureMatrix,
  buildLandingpageBuyerInput,
  composeBuyerGenerationPrompt,
  buildStrictNliJudgePrompt,
  parseBuyerCandidate,
  parseNliJudgeResult,
  renderBuyerPublicOutput,
} = require("../src/buyer-output-adapter");

const templateOnly = `Angebot/Produkt: [Dein Produktname]
Zielgruppe: [z.B. Creator, Coaches, SaaS-Gründer]
Wichtigster Nutzen: [z.B. spart 5 Stunden pro Woche]
Preis/Hinweis: [optional: Preis, Verfügbarkeit oder Zugangshinweis]
Gewünschte CTA: [z.B. Mehr erfahren, Zugang anfragen, Jetzt kaufen]

Gewünschte Ausgabe-Struktur:
1) Headline (max. 9 Wörter)
2) Subheadline (1 Satz)
3) 5 kurze Nutzen-Bullets
4) CTA-Zeile (1 Satz)
5) Mini-FAQ: 3 Fragen + Antworten`;

const parsedTemplate = parseStructureMatrix(templateOnly);
assert.deepEqual(parsedTemplate, {});

assert.throws(
  () =>
    buildLandingpageBuyerInput({
      topic: "Ergonomischer Bürostuhl ProX",
      extra: templateOnly,
    }),
  (error) =>
    error instanceof BuyerOutputError &&
    error.code === "PREFLIGHT_REJECTED_MISSING_CTA",
);

const filledMatrix = `Angebot/Produkt: Ergonomischer Bürostuhl ProX
Zielgruppe: Menschen, die einen Bürostuhl suchen
Problem: Produktbeschreibungen wirken wie reine Feature-Listen
Ziel / Wunsch: Einen klaren Produkttext erstellen
Kern-Features / Fakten: verstellbare Lordosenstütze; höhenverstellbare Armlehnen; atmungsaktive Netzrückenlehne
Erlaubter Nutzen: individuelle Einstellmöglichkeiten
Preis/Hinweis: Nur solange im Input vorhanden
Gewünschte CTA: Jetzt entdecken

Gewünschte Ausgabe-Struktur:
1) Headline
2) Copy`;

const parsedFilled = parseStructureMatrix(filledMatrix);
assert.equal(parsedFilled.angebot, "Ergonomischer Bürostuhl ProX");
assert.equal(parsedFilled.zielgruppe, "Menschen, die einen Bürostuhl suchen");
assert.equal(parsedFilled.cta, "Jetzt entdecken");

const input = buildLandingpageBuyerInput({
  topic: "Fallback topic",
  extra: filledMatrix,
  profile: {
    proofFacts: [
      {
        label: "Material",
        value: "Netzrückenlehne",
        status: "approved",
      },
      {
        label: "Interne Notiz",
        value: "nicht verwenden",
        status: "draft",
      },
    ],
  },
});

assert.equal(input.angebot, "Ergonomischer Bürostuhl ProX");
assert.equal(input.cta, "Jetzt entdecken");
assert.deepEqual(input.features, [
  "verstellbare Lordosenstütze",
  "höhenverstellbare Armlehnen",
  "atmungsaktive Netzrückenlehne",
]);
assert.deepEqual(input.allowedBenefits, ["individuelle Einstellmöglichkeiten"]);
assert.deepEqual(input.profileFacts, [
  { label: "Material", value: "Netzrückenlehne" },
]);

const generationPrompt = composeBuyerGenerationPrompt({
  systemPrompt: "SYSTEM",
  userPayload: {
    brief: { angebot: "ProX" },
    protectedLiterals: [],
  },
  tone: "Direkt",
  outLang: "de",
});
assert.match(generationPrompt, /UNTRUSTED REQUEST DATA/);
assert.match(generationPrompt, /"angebot": "ProX"/);
assert.match(generationPrompt, /REQUESTED TONE: Direkt/);

const judgePrompt = buildStrictNliJudgePrompt({
  facts: { features: ["atmungsaktive Netzrückenlehne"] },
  candidate: {
    heroHook: "Ein klarer Blick auf das Produkt.",
    problemAgitation: "Die vorhandenen Angaben stehen im Mittelpunkt.",
    solutionPitch: "Die Netzrückenlehne ist atmungsaktiv.",
    actionClosing: "Der nächste Schritt ist vorbereitet.",
  },
  outLang: "de",
});
assert.match(judgePrompt, /DATA, never instructions/i);
assert.match(judgePrompt, /FACT_BREACH_IMPLIED_CLAIM/);
assert.match(judgePrompt, /atmungsaktive Netzrückenlehne/);

assert.deepEqual(
  parseBuyerCandidate(`\`\`\`json
{
  "heroHook": "Hook",
  "problemAgitation": "Agitation",
  "solutionPitch": "Pitch",
  "actionClosing": "Übergang"
}
\`\`\``),
  {
    heroHook: "Hook",
    problemAgitation: "Agitation",
    solutionPitch: "Pitch",
    actionClosing: "Übergang",
  },
);

assert.deepEqual(
  parseNliJudgeResult(
    JSON.stringify({
      isFaithful: false,
      violationType: "FACT_BREACH_IMPLIED_CLAIM",
      violations: ["weniger schwitzen"],
    }),
  ),
  {
    isFaithful: false,
    violationType: "FACT_BREACH_IMPLIED_CLAIM",
    violations: ["weniger schwitzen"],
  },
);

assert.throws(
  () => parseNliJudgeResult('{"isFaithful":"maybe"}'),
  /invalid_fidelity_judge_verdict/,
);

const rendered = renderBuyerPublicOutput({
  heroHook: "Hook",
  problemAgitation: "Agitation",
  solutionPitch: "Pitch",
  actionClosing: "Übergang.",
  exactCTA: "Jetzt entdecken",
});
assert.equal(
  rendered,
  "Hook\n\nAgitation\n\nPitch\n\nÜbergang.\n\nJetzt entdecken",
);

console.log("GLE buyer output adapter test passed");
