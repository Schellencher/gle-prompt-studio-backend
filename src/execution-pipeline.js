"use strict";

const EXECUTION_PIPELINE_VERSION = "execution-pipeline-v1";

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

  let formatRules = "";

  if (stepId === "social") {
    formatRules = isEnglish
      ? [
          "Create a Social Media Post with exactly 7 non-empty lines.",
          "Line 1: neutral hook.",
          "Line 2: concise main statement.",
          "Lines 3-5: exactly three bullet lines.",
          "Line 6: neutral engagement question.",
          "Line 7: neutral CTA.",
        ].join("\n")
      : [
          "Erstelle einen Social Media Post mit exakt 7 nicht-leeren Zeilen.",
          "Zeile 1: neutraler Hook.",
          "Zeile 2: kurze Hauptaussage.",
          "Zeilen 3-5: exakt drei Bullet-Zeilen.",
          "Zeile 6: neutrale Interaktionsfrage.",
          "Zeile 7: neutrale CTA.",
        ].join("\n");
  } else if (stepId === "linkedin") {
    formatRules = isEnglish
      ? [
          "Create a LinkedIn Post.",
          "Use a clear opening, short readable paragraphs and one neutral CTA.",
          "Do not add unsupported claims or artificial urgency.",
        ].join("\n")
      : [
          "Erstelle einen LinkedIn Post.",
          "Nutze einen klaren Einstieg, kurze lesbare Absätze und eine neutrale CTA.",
          "Keine unbelegten Claims oder künstliche Dringlichkeit.",
        ].join("\n");
  } else if (stepId === "email") {
    formatRules = isEnglish
      ? [
          "Create an email.",
          "Start with a subject line labelled 'Subject:'.",
          "Then provide a concise email body and one neutral CTA.",
        ].join("\n")
      : [
          "Erstelle eine E-Mail.",
          "Beginne mit einer Betreffzeile im Format „Betreff:“.",
          "Danach folgen ein kompakter E-Mail-Text und eine neutrale CTA.",
        ].join("\n");
  } else {
    throw new PipelineError(
      "invalid_pipeline_step",
      "Der Pipeline-Schritt ist ungültig.",
    );
  }

  return [
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
