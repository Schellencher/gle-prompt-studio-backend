"use strict";

const { buildAntiFluffPromptBlock } = require("./anti-fluff");

function cleanLine(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLanguage(outLang) {
  return String(outLang || "de").toLowerCase().startsWith("en") ? "en" : "de";
}

function topicLabel(topic, outLang = "de") {
  const lang = normalizeLanguage(outLang);
  const raw = cleanLine(topic).replace(/[.!?]+$/g, "").trim();
  if (!raw) return lang === "en" ? "the topic" : "das Thema";
  return raw;
}

function shortHeadlineFromTopic(topic, outLang = "de") {
  const lang = normalizeLanguage(outLang);
  const raw = topicLabel(topic, outLang);
  if (!raw || raw === "das Thema" || raw === "the topic") {
    return lang === "en" ? "Clear information at a glance" : "Klare Informationen auf einen Blick";
  }

  const words = raw.split(/\s+/).filter(Boolean).slice(0, 9);
  return words.join(" ");
}

function buildLandingpageJsonPrompt({ useCase, tone, topic, extra, outLang }) {
  const lang = normalizeLanguage(outLang);
  const languageName = lang === "en" ? "English" : "Deutsch";
  const safeTopic = cleanLine(topic);
  const safeExtra = cleanLine(extra);

  return `
Du bist ein präziser Copywriter für Landingpages und Anzeigen.
Du schreibst über das tatsächlich angegebene Thema oder Angebot — niemals automatisch über GLE Prompt Studio, SaaS, KI-Tools oder Early Access.

WICHTIG:
Gib ausschließlich gültiges JSON aus.
Kein Markdown.
Keine Einleitung.
Keine Kommentare.
Keine Erklärungen außerhalb des JSON.

Zielsprache: ${languageName}
Use-Case: ${cleanLine(useCase)}
Ton: ${cleanLine(tone)}

${buildAntiFluffPromptBlock({ outLang: lang, stage: "landingpage-generate" })}

THEMA / ANGEBOT:
${safeTopic || "Keine weiteren Angaben."}

ZUSATZANFORDERUNGEN:
${safeExtra || "Keine weiteren Angaben."}

AUFGABE:
Erstelle eine klare Landingpage-/Ad-Copy-Struktur passend zum angegebenen Thema oder Angebot.

FAKTENREGELN:
- THEMA / ANGEBOT und ZUSATZANFORDERUNGEN sind die einzigen vorgegebenen Fakten.
- Erfinde keine Preise, Statistiken, Studien, Verfügbarkeiten, Produktmerkmale, Zielgruppen, Termine oder Leistungsversprechen.
- Bei Gesundheit, Medizin, Finanzen oder Recht keine unbelegten Wirkungs-, Sicherheits- oder Erfolgsaussagen ergänzen.
- Fehlt eine Information, formuliere neutral statt sie zu erfinden.
- Keine Behauptung über GLE Prompt Studio, außer GLE wurde ausdrücklich im Thema genannt.
- Keine Warteliste oder Early-Access-CTA, außer dies wurde ausdrücklich verlangt.

STILREGELN:
- Natürlich, konkret und professionell.
- Headline maximal 9 Wörter.
- Genau 5 Bulletpoints.
- Genau 3 FAQ-Paare.
- CTA neutral und passend zum Thema; ohne konkrete Vorgabe standardmäßig "${lang === "en" ? "Learn more." : "Mehr erfahren."}".

JSON-SCHEMA:
{
  "headline": "maximal 9 Wörter",
  "subheadline": "ein natürlicher Satz zum angegebenen Thema oder Angebot",
  "bullets": [
    "konkreter Punkt 1",
    "konkreter Punkt 2",
    "konkreter Punkt 3",
    "konkreter Punkt 4",
    "konkreter Punkt 5"
  ],
  "cta": "kurze neutrale CTA",
  "faq": [
    { "q": "Frage 1 zum angegebenen Thema", "a": "vollständige Antwort ohne erfundene Fakten" },
    { "q": "Frage 2 zum angegebenen Thema", "a": "vollständige Antwort ohne erfundene Fakten" },
    { "q": "Frage 3 zum angegebenen Thema", "a": "vollständige Antwort ohne erfundene Fakten" }
  ]
}

Gib nur gültiges JSON aus.
`.trim();
}

function buildLandingpageJsonRepairPrompt({ badOutput, topic, outLang }) {
  const lang = normalizeLanguage(outLang);
  const safeTopic = cleanLine(topic);

  return `
Wandle den folgenden Inhalt in gültiges JSON um.
Gib ausschließlich JSON aus. Kein Markdown. Keine Erklärung.

${buildAntiFluffPromptBlock({ outLang: lang, stage: "landingpage-repair" })}

THEMA / ANGEBOT:
${safeTopic || (lang === "en" ? "No topic provided." : "Kein Thema angegeben.")}

WICHTIG:
- Inhalt und Thema beibehalten.
- Keine neuen Preise, Fakten, Statistiken, Wirkungsversprechen oder Produktmerkmale erfinden.
- Nicht automatisch GLE Prompt Studio, SaaS, Early Access oder Warteliste einsetzen.
- Wenn keine CTA erkennbar ist, nutze "${lang === "en" ? "Learn more." : "Mehr erfahren."}".

JSON-SCHEMA:
{
  "headline": "maximal 9 Wörter",
  "subheadline": "ein natürlicher Satz",
  "bullets": ["Bullet 1", "Bullet 2", "Bullet 3", "Bullet 4", "Bullet 5"],
  "cta": "kurze neutrale CTA",
  "faq": [
    { "q": "Frage 1", "a": "Antwort 1" },
    { "q": "Frage 2", "a": "Antwort 2" },
    { "q": "Frage 3", "a": "Antwort 3" }
  ]
}

ALTER OUTPUT:
${String(badOutput || "")}
`.trim();
}

function renderLandingpageOutput(data, { outLang = "de", topic = "" } = {}) {
  const lang = normalizeLanguage(outLang);
  const isEn = lang === "en";
  const topicName = topicLabel(topic, outLang);

  const labels = isEn
    ? { bullets: "Bullet points", cta: "CTA line", faq: "Mini FAQ", question: "Question", answer: "Answer" }
    : { bullets: "Bulletpoints", cta: "CTA-Zeile", faq: "Mini-FAQ", question: "Frage", answer: "Antwort" };

  const headline = cleanLine(data?.headline) || shortHeadlineFromTopic(topic, outLang);
  const subheadline = cleanLine(data?.subheadline) || (isEn
    ? `A clear overview of ${topicName}.`
    : `Ein klarer Überblick zu ${topicName}.`);

  const rawBullets = Array.isArray(data?.bullets) ? data.bullets : [];
  const bullets = rawBullets.map(cleanLine).filter(Boolean).slice(0, 5);

  const fallbackBullets = isEn
    ? [
        `Key aspects of ${topicName} at a glance.`,
        `Clear structure for the most important information about ${topicName}.`,
        `Relevant points can be compared without adding unsupported claims.`,
        `Open questions remain visible instead of being filled with invented facts.`,
        `Further details can be added when reliable information is available.`,
      ]
    : [
        `Wichtige Aspekte zu ${topicName} auf einen Blick.`,
        `Klare Struktur für die zentralen Informationen zu ${topicName}.`,
        `Relevante Punkte lassen sich ohne unbelegte Zusatzbehauptungen einordnen.`,
        `Offene Fragen bleiben sichtbar, statt mit erfundenen Fakten gefüllt zu werden.`,
        `Weitere Details können ergänzt werden, sobald verlässliche Angaben vorliegen.`,
      ];

  for (const fallback of fallbackBullets) {
    if (bullets.length >= 5) break;
    bullets.push(cleanLine(fallback));
  }

  const cta = cleanLine(data?.cta) || (isEn ? "Learn more." : "Mehr erfahren.");

  const rawFaq = Array.isArray(data?.faq) ? data.faq : [];
  const faq = rawFaq
    .map((item) => ({
      q: cleanLine(item?.q || item?.question || ""),
      a: cleanLine(item?.a || item?.answer || ""),
    }))
    .filter((item) => item.q && item.a)
    .slice(0, 3);

  const fallbackFaq = isEn
    ? [
        { q: `What is this page about?`, a: `It provides a structured overview of ${topicName}.` },
        { q: `Which information is included?`, a: `Only the supplied information and clearly worded general context should be included.` },
        { q: `Can more details be added?`, a: `Yes. Additional verified information can be added when it is available.` },
      ]
    : [
        { q: `Worum geht es auf dieser Seite?`, a: `Sie bietet einen strukturierten Überblick zu ${topicName}.` },
        { q: `Welche Informationen werden berücksichtigt?`, a: `Berücksichtigt werden die vorgegebenen Angaben und neutral formulierter Kontext ohne erfundene Fakten.` },
        { q: `Können weitere Details ergänzt werden?`, a: `Ja. Zusätzliche verlässliche Informationen können ergänzt werden, sobald sie vorliegen.` },
      ];

  for (const fallback of fallbackFaq) {
    if (faq.length >= 3) break;
    faq.push({ q: cleanLine(fallback.q), a: cleanLine(fallback.a) });
  }

  return [
    `1) ${headline}`,
    `2) ${subheadline}`,
    `3) ${labels.bullets}:`,
    ...bullets.map((b) => `- ${b}`),
    `4) ${labels.cta}: ${cta}`,
    `5) ${labels.faq}:`,
    ...faq.flatMap((item) => [
      `- ${labels.question}: ${item.q}`,
      `  ${labels.answer}: ${item.a}`,
    ]),
  ].join("\n");
}

module.exports = {
  buildLandingpageJsonPrompt,
  buildLandingpageJsonRepairPrompt,
  renderLandingpageOutput,
};
