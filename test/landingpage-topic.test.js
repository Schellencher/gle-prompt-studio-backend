"use strict";

const assert = require("assert");
const {
  buildLandingpageJsonPrompt,
  buildLandingpageJsonRepairPrompt,
  renderLandingpageOutput,
} = require("../src/landingpage-structured");

const topic = "Diät 2026 und die Auswirkungen auf das Nervensystem.";

const prompt = buildLandingpageJsonPrompt({
  useCase: "Landingpage / Ad-Copy",
  tone: "Professionell",
  topic,
  extra: "",
  outLang: "de",
});

assert(prompt.includes(topic), "Prompt must contain the actual user topic");
assert(prompt.includes("niemals automatisch über GLE Prompt Studio"), "Prompt must explicitly prevent GLE topic injection");
assert(prompt.includes("Erfinde keine Preise"), "Prompt must prohibit invented prices");

const repair = buildLandingpageJsonRepairPrompt({
  badOutput: "not json",
  topic,
  outLang: "de",
});
assert(repair.includes(topic), "Repair prompt must preserve the actual user topic");
assert(!repair.includes('"cta": "Zur Warteliste."'), "Repair schema must not force a waitlist CTA");

const fallback = renderLandingpageOutput({}, { outLang: "de", topic });
assert(/Diät 2026|Nervensystem/.test(fallback), "Fallback must remain related to the user topic");
assert(!/GLE Prompt Studio/i.test(fallback), "Fallback must not inject GLE Prompt Studio");
assert(!/19,99|19\.99/.test(fallback), "Fallback must not invent a price");
assert(!/Zur Warteliste/i.test(fallback), "Fallback must not force a waitlist CTA");
assert(/4\) CTA-Zeile: Mehr erfahren\./.test(fallback), "Fallback should use a neutral CTA");

const rendered = renderLandingpageOutput(
  {
    headline: "Nervensystem und Ernährung im Blick",
    subheadline: "Eine sachliche Übersicht zum gewählten Thema.",
    bullets: ["Punkt A", "Punkt B", "Punkt C", "Punkt D", "Punkt E"],
    cta: "Mehr erfahren.",
    faq: [
      { q: "Frage A?", a: "Antwort A." },
      { q: "Frage B?", a: "Antwort B." },
      { q: "Frage C?", a: "Antwort C." },
    ],
  },
  { outLang: "de", topic },
);
assert(rendered.includes("Nervensystem und Ernährung im Blick"));
assert(!/GLE Prompt Studio/i.test(rendered));

console.log("GLE landingpage topic test passed");
