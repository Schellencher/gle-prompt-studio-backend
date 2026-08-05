"use strict";

const EXECUTION_PIPELINE_VERSION = "execution-pipeline-v1.2";

const PIPELINE_TEMPLATES = {
  content_pack: [
    {
      id: "social",
      useCase: "Social Media Post",
    },
    {
      id: "linkedin",
      useCase: "LinkedIn Post",
    },
    {
      id: "email",
      useCase: "E-Mail",
    },
  ],
};

class PipelineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.status = status;
  }
}

function normalizePipelineTemplate(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  return Object.prototype.hasOwnProperty.call(
    PIPELINE_TEMPLATES,
    normalized,
  )
    ? normalized
    : "";
}

function normalizeOutputLanguage(value) {
  const normalized = String(value || "de")
    .trim()
    .toLowerCase();

  return normalized.startsWith("en") ? "en" : "de";
}

function validatePipelineInput(input = {}) {
  const template = normalizePipelineTemplate(input.template);

  if (!template) {
    throw new PipelineError(
      "invalid_pipeline_template",
      "Die ausgewählte Pipeline-Vorlage ist ungültig.",
    );
  }

  const topic = String(input.topic || "").trim();

  if (!topic) {
    throw new PipelineError(
      "missing_topic",
      "Für die Pipeline wird ein Thema benötigt.",
    );
  }

  return {
    template,
    topic,
    tone: String(input.tone || "Professionell").trim() || "Professionell",
    outLang: normalizeOutputLanguage(input.outLang || input.language),
    extra: String(input.extra || "").trim(),
  };
}

function getPipelineSteps(template) {
  const normalized = normalizePipelineTemplate(template);

  if (!normalized) {
    throw new PipelineError(
      "invalid_pipeline_template",
      "Die ausgewählte Pipeline-Vorlage ist ungültig.",
    );
  }

  return PIPELINE_TEMPLATES[normalized].map((step) => ({ ...step }));
}


function buildPipelineStepExtra({ step, extra, outLang } = {}) {
  const stepId = String(step?.id || "").trim().toLowerCase();
  const isEnglish = String(outLang || "de").toLowerCase().startsWith("en");
  const userExtra = String(extra || "").trim();

  const sharedRules = isEnglish
    ? [
        "Use exclusively information explicitly supported by the selected profile facts.",
        "Preserve all names, numbers, units, limitations and qualifiers exactly.",
        "Do not infer benefits, use cases, suitability, quality, performance, compatibility, convenience, atmosphere, urgency, recommendations or audience assumptions.",
        "A technical fact must not be transformed into a marketing promise.",
        "Do not mention profiles, approved facts, grounding or Fact Guard in the output.",
        "The output must be immediately usable and specific to its requested format.",
      ].join("\n")
    : [
        "Verwende ausschließlich Informationen, die ausdrücklich durch die ausgewählten Profil-Fakten gestützt sind.",
        "Erhalte Namen, Zahlen, Einheiten, Einschränkungen und Qualifizierungen exakt.",
        "Leite keine Vorteile, Einsatzbereiche, Eignungen, Qualitätsaussagen, Leistungsversprechen, Kompatibilität, Bequemlichkeit, Atmosphäre, Dringlichkeit, Empfehlungen oder Zielgruppenannahmen ab.",
        "Ein technischer Fakt darf nicht in ein Werbeversprechen umgewandelt werden.",
        "Erwähne im Ergebnis weder Profile noch freigegebene Fakten, Grounding oder Fact Guard.",
        "Das Ergebnis muss sofort einsetzbar und eindeutig auf das angeforderte Format zugeschnitten sein.",
      ].join("\n");

  let formatRules = "";

  if (stepId === "social") {
    formatRules = isEnglish
      ? [
          "Create a Social Media Post with exactly 7 non-empty lines.",
          "Line 1: product name plus a neutral overview phrase.",
          "Line 2: one short neutral bridge sentence without an additional product claim.",
          "Lines 3-5: exactly three bullet lines, each containing one supported product fact.",
          "Line 6: a direct engagement question referring only to the listed facts.",
          "Line 7: one short neutral CTA.",
          "Do not use hashtags, emojis or LinkedIn-style paragraphs.",
        ].join("\n")
      : [
          "Erstelle einen Social Media Post mit exakt 7 nicht-leeren Zeilen.",
          "Zeile 1: Produktname plus eine neutrale Überblicksformulierung.",
          "Zeile 2: ein kurzer neutraler Übergangssatz ohne zusätzlichen Produkt-Claim.",
          "Zeilen 3-5: exakt drei Bullet-Zeilen mit jeweils einem gestützten Produktfakt.",
          "Zeile 6: eine direkte Interaktionsfrage, die sich nur auf die aufgeführten Fakten bezieht.",
          "Zeile 7: eine kurze neutrale CTA.",
          "Keine Hashtags, Emojis oder LinkedIn-artigen Absätze.",
        ].join("\n");
  } else if (stepId === "linkedin") {
    formatRules = isEnglish
      ? [
          "Create a professional LinkedIn Post, not a Social Media Post copy.",
          "Start with a clear factual headline.",
          "Follow with a short professional framing paragraph.",
          "Present the supported product facts as complete readable statements.",
          "Use more context and sentence structure than the Social Media format, but add no new product claims.",
          "End with one professional discussion question and one neutral CTA.",
          "Do not use the exact 7-line Social Media structure.",
        ].join("\n")
      : [
          "Erstelle einen professionellen LinkedIn Post und keine Kopie des Social-Media-Posts.",
          "Beginne mit einer klaren sachlichen Überschrift.",
          "Danach folgt ein kurzer professioneller Einordnungsabsatz.",
          "Stelle die gestützten Produktfakten als vollständige, gut lesbare Aussagen dar.",
          "Nutze mehr Kontext und Satzstruktur als beim Social-Media-Format, aber ergänze keine neuen Produkt-Claims.",
          "Beende den Beitrag mit einer professionellen Diskussionsfrage und einer neutralen CTA.",
          "Verwende nicht die exakte 7-Zeilen-Struktur des Social-Media-Posts.",
        ].join("\n");
  } else if (stepId === "email") {
    formatRules = isEnglish
      ? [
          "Create a complete, ready-to-send email, not a reformatted social post.",
          "Start with a subject line labelled 'Subject:'.",
          "Use a neutral greeting without invented recipient names.",
          "State the reason for the email in one concise sentence.",
          "Present exactly three supported product facts in a compact, readable section.",
          "Add one neutral next-step sentence and a simple sign-off.",
          "Do not add sender placeholders, company names, promises or availability claims.",
        ].join("\n")
      : [
          "Erstelle eine vollständige, versandfertige E-Mail und keinen umformatierten Social-Media-Post.",
          "Beginne mit einer Betreffzeile im Format „Betreff:“.",
          "Nutze eine neutrale Anrede ohne erfundene Empfängernamen.",
          "Nenne den Anlass der E-Mail in einem kompakten Satz.",
          "Stelle exakt drei gestützte Produktfakten in einem übersichtlichen Abschnitt dar.",
          "Ergänze einen neutralen nächsten Schritt und einen einfachen Gruß.",
          "Keine Absender-Platzhalter, Firmennamen, Versprechen oder Verfügbarkeitsaussagen ergänzen.",
        ].join("\n");
  } else {
    throw new PipelineError(
      "invalid_pipeline_step",
      "Der Pipeline-Schritt ist ungültig.",
    );
  }

  return [
    sharedRules,
    formatRules,
    userExtra
      ? `${isEnglish ? "Additional requirements" : "Zusätzliche Anforderungen"}:\n${userExtra}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
function getPipelineUsageCost(template) {
  return getPipelineSteps(template).length;
}

module.exports = {
  EXECUTION_PIPELINE_VERSION,
  PipelineError,
  normalizePipelineTemplate,
  validatePipelineInput,
  getPipelineSteps,
  getPipelineUsageCost,
  buildPipelineStepExtra,
};
