"use strict";

const ANTI_FLUFF_VERSION = "anti-fluff-v1";

// Required meta/refusal stems are always active, even if an env override is used.
const REQUIRED_BANNED_STEMS = [
  "tutmirleid",
  "bittegib",
  "benoetig",
  "mehrinformation",
  "ichkann",
  "imsorry",
  "cantcomply",
  "cannotcomply",
];

// Existing production Bouncer defaults. Keep the behavior stable while moving
// the policy into one reusable module for Generate, Repair and future Quick Actions.
const DEFAULT_BANNED_STEMS = [
  "optimier",
  "steiger",
  "verbesser",
  "erleb",
  "profit",
  "verpass",
  "chance",
  "exklus",
  "konkurrenz",
  "agentur",
  "erfolg",
  "nutz",
  "vorteil",
  "vorsp",
  "sicher",
  "leader",
  "luxus",
  "strateg",
];

function normalizeForScan(input) {
  let s = String(input || "").toLowerCase();
  s = s
    // Normal UTF-8 German characters.
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    // Also tolerate legacy mojibake already present in older prompt strings.
    .replace(/Ã¤/g, "ae")
    .replace(/Ã¶/g, "oe")
    .replace(/Ã¼/g, "ue")
    .replace(/ÃŸ/g, "ss");
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return s
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function splitEnvStems(envVal) {
  const raw = String(envVal || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const value of arr || []) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function getActiveBannedStems(env = process.env) {
  const fromEnv = splitEnvStems(env?.BOUNCER_BANNED_STEMS);
  const base = fromEnv.length ? fromEnv : DEFAULT_BANNED_STEMS;
  const combined = dedupeKeepOrder([...base, ...REQUIRED_BANNED_STEMS]);
  return dedupeKeepOrder(
    combined
      .map((stem) => normalizeForScan(stem).replace(/\s+/g, ""))
      .filter(Boolean),
  );
}

function findStemViolations(text, stems = getActiveBannedStems()) {
  const hay = normalizeForScan(text);
  if (!hay) return [];
  const hayCompact = hay.replace(/\s+/g, "");
  const hits = [];

  for (const stemRaw of stems || []) {
    const stem = normalizeForScan(stemRaw).replace(/\s+/g, "");
    if (!stem) continue;
    if (hayCompact.includes(stem)) hits.push(stem);
  }

  return dedupeKeepOrder(hits);
}

function normalizeLanguage(outLang) {
  return String(outLang || "DE").toLowerCase().startsWith("en") ? "en" : "de";
}

function buildAntiFluffPromptBlock({ outLang = "DE", stage = "generate" } = {}) {
  const isEn = normalizeLanguage(outLang) === "en";
  const stageLabel = String(stage || "generate").toLowerCase();

  const rules = isEn
    ? [
        `[GLE_ANTI_FLUFF_V1:${stageLabel}]`,
        "QUALITY / STYLE RULES:",
        "- Return only finished content. No meta commentary, apologies, preambles or process explanations.",
        "- No empty marketing filler, hype language or generic superlatives.",
        "- Prefer concrete, plain wording over slogans and vague promises.",
        "- Do not add urgency, scarcity or exclusivity unless the user explicitly supplied it.",
        "- No emojis.",
        "- Use at most one CTA; keep it neutral and non-transactional unless the requested format explicitly says otherwise.",
        "- Never add 'Link in Bio'.",
        "- Do not mention internal platform terms such as BYOK, server key, tokens, model name, GPT or API unless the topic explicitly requires them.",
        "- Preserve the requested tone and form of address; Anti-Fluff must not silently switch between formal and informal address.",
        `[END_GLE_ANTI_FLUFF_V1:${stageLabel}]`,
      ]
    : [
        `[GLE_ANTI_FLUFF_V1:${stageLabel}]`,
        "QUALITÄTS- / STILREGELN:",
        "- Gib nur fertigen Content aus. Kein Meta, keine Entschuldigungen, keine Vorrede und keine Prozess-Erklärung.",
        "- Keine leeren Werbefloskeln, Hype-Sprache oder generischen Superlative.",
        "- Bevorzuge konkrete, einfache Formulierungen statt Slogans und vager Versprechen.",
        "- Keine künstliche Dringlichkeit, Verknappung oder Exklusivität, sofern der Nutzer sie nicht ausdrücklich vorgibt.",
        "- Keine Emojis.",
        "- Höchstens eine CTA; neutral und nicht-transaktional, sofern das gewünschte Format nichts anderes ausdrücklich verlangt.",
        "- Kein 'Link in Bio'.",
        "- Keine internen Plattformbegriffe wie BYOK, Server-Key, Tokens, Modellname, GPT oder API, außer das Thema verlangt sie ausdrücklich.",
        "- Gewünschten Ton und Anredeform beibehalten; Anti-Fluff darf nicht eigenmächtig zwischen du/Sie wechseln.",
        `[END_GLE_ANTI_FLUFF_V1:${stageLabel}]`,
      ];

  return rules.join("\n");
}

function buildAntiFluffRepairBlock({
  outLang = "DE",
  hits = [],
  activeBannedStems = getActiveBannedStems(),
} = {}) {
  const isEn = normalizeLanguage(outLang) === "en";
  const hitList = dedupeKeepOrder(hits).join(", ") || (isEn ? "none" : "keine");
  const bannedList = dedupeKeepOrder(activeBannedStems).join(", ") || (isEn ? "none" : "keine");

  return [
    buildAntiFluffPromptBlock({ outLang, stage: "repair" }),
    "",
    isEn ? "BOUNCER REPAIR RULES:" : "BOUNCER-REPARATURREGELN:",
    isEn
      ? "- Rewrite the affected wording completely if needed; do not explain the repair."
      : "- Betroffene Formulierungen bei Bedarf komplett neu schreiben; die Reparatur nicht erklären.",
    isEn
      ? `- Detected banned stems in the previous draft: ${hitList}`
      : `- Erkannte verbotene Wortstämme im letzten Entwurf: ${hitList}`,
    isEn
      ? `- These banned stems must not appear in the repaired output: ${bannedList}`
      : `- Diese verbotenen Wortstämme dürfen im reparierten Output nicht vorkommen: ${bannedList}`,
    isEn
      ? "- Do not reuse an unsafe phrase merely with synonyms around the same hype claim."
      : "- Eine problematische Floskel nicht nur mit Synonymen um denselben Hype-Claim herum neu verpacken.",
  ].join("\n");
}

function detectCtaLabelFromExtra(extra) {
  const s = String(extra || "");
  if (/CTA-Zeile/i.test(s)) return "CTA-Zeile";
  if (/CTA\s*:/i.test(s)) return "CTA";
  return null;
}

function normalizeCtaLabel(output, extra) {
  const want = detectCtaLabelFromExtra(extra);
  if (!want) return String(output || "");

  return String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:\d+\)\s*)?)(CTA(?:-Zeile)?\s*:)(.*)$/i);
      if (!m) return line;
      return `${m[1]}${want}:${m[3] || ""}`;
    })
    .join("\n");
}

function neutralCta(outLang = "DE") {
  return normalizeLanguage(outLang) === "en" ? "Learn more." : "Mehr erfahren.";
}

function forceNeutralCTA(output, extra, outLang = "DE") {
  const want = detectCtaLabelFromExtra(extra);
  const chosen = neutralCta(outLang);

  const out = String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:\d+\)\s*)?)(CTA(?:-Zeile)?\s*:)\s*(.*)$/i);
      if (!m) return line;
      const label = want ? `${want}:` : m[2];
      return `${m[1]}${label} ${chosen}`;
    })
    .join("\n");

  const expects = /CTA-Zeile/i.test(String(extra || "")) || /CTA\s*:/i.test(String(extra || ""));
  const hasCta = /(^|\n)\s*(\d+\)\s*)?CTA(?:-Zeile)?\s*:/i.test(out);
  if (expects && !hasCta) {
    const label = want ? `${want}:` : "CTA:";
    return `${out}\n\n${label} ${chosen}`;
  }
  return out;
}

// Legacy last-mile helper retained as an exported name so existing call sites can
// migrate without a behavior cliff. It is intentionally conservative: broad
// semantic stems such as "nutz", "sicher" or "strateg" are handled by the
// model rewrite Bouncer instead of brittle word replacement that can damage grammar.
function hardStripHotStems(output) {
  let s = String(output || "");

  const repl = [
    [/\b(hochwertig\w*|blitzschnell\w*|revolution\w*|premium\w*)\b/gi, ""],
    [/\blink\s+in\s+(?:der\s+|meiner\s+)?bio\b/gi, ""],
    [/\blink\s+in\s+bio\b/gi, ""],
  ];

  for (const [rx, to] of repl) s = s.replace(rx, to);

  return s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  ANTI_FLUFF_VERSION,
  REQUIRED_BANNED_STEMS,
  DEFAULT_BANNED_STEMS,
  normalizeForScan,
  getActiveBannedStems,
  findStemViolations,
  buildAntiFluffPromptBlock,
  buildAntiFluffRepairBlock,
  normalizeCtaLabel,
  forceNeutralCTA,
  hardStripHotStems,
};
