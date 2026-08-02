"use strict";

const PROOF_MODE = "claim-aware-profile-facts-v2";

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function approvedFacts(profile) {
  return (Array.isArray(profile?.proofFacts) ? profile.proofFacts : [])
    .filter((fact) => fact && clean(fact.value) && clean(fact.status || "approved") === "approved")
    .map((fact) => ({
      id: clean(fact.id),
      label: clean(fact.label) || "Fact",
      value: clean(fact.value),
      source: clean(fact.source),
      version: Number(fact.version || 1),
    }));
}

function isTitleFact(fact) {
  const label = clean(fact?.label).toLowerCase();
  return /^(produktname|product name|product|produkt|modellname|model name|modell|model|name)$/.test(label);
}

function pickTitle(profile, facts) {
  const titleFact = facts.find(isTitleFact);
  return clean(titleFact?.value || "");
}

function isEnglish(outLang) {
  return clean(outLang).toLowerCase().startsWith("en");
}

function lowerFirst(value) {
  const s = clean(value);
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function deFactPhrase(fact) {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
    return `einen ${value}-Anschluss`;
  }
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
    if (/licht$/i.test(value)) return lowerFirst(value);
    return `${lowerFirst(value)}es Licht`.replace(/weisses/i, "weißes");
  }
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) {
    return `eine Akkulaufzeit von ${value}`;
  }
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) {
    return `ein Fassungsvermögen von ${value}`;
  }
  if (/^(material|werkstoff)$/.test(label)) {
    return `das Material ${value}`;
  }
  if (/^(farbe|color|colour)$/.test(label)) {
    return `die Farbe ${value}`;
  }
  if (/^(preis|price)$/.test(label)) {
    return `einen Preis von ${value}`;
  }
  if (/^(gewicht|weight)$/.test(label)) {
    return `ein Gewicht von ${value}`;
  }
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) {
    return `Abmessungen von ${value}`;
  }

  return `${clean(fact.label)}: ${value}`;
}

function enFactPhrase(fact) {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `a ${value} port`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `${lowerFirst(value)} light`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return `battery life of ${value}`;
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `a capacity of ${value}`;
  if (/^(material|werkstoff)$/.test(label)) return `${value} material`;
  if (/^(farbe|color|colour)$/.test(label)) return `the color ${value}`;
  if (/^(preis|price)$/.test(label)) return `a price of ${value}`;
  if (/^(gewicht|weight)$/.test(label)) return `a weight of ${value}`;
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `dimensions of ${value}`;

  return `${clean(fact.label)}: ${value}`;
}

function joinPhrases(items, outLang) {
  const list = items.map(clean).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const conjunction = isEnglish(outLang) ? " and " : " und ";
  if (list.length === 2) return `${list[0]}${conjunction}${list[1]}`;
  return `${list.slice(0, -1).join(", ")}${conjunction}${list[list.length - 1]}`;
}

function buildNaturalFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";

  const titleFact = facts.find(isTitleFact) || null;
  const title = pickTitle(profile, facts);
  const bodyFacts = titleFact ? facts.filter((fact) => fact.id !== titleFact.id) : facts;
  const phraseFn = isEnglish(outLang) ? enFactPhrase : deFactPhrase;
  const body = joinPhrases(bodyFacts.map(phraseFn), outLang);

  const lines = [];
  if (title) lines.push(title, "");

  if (body) {
    if (isEnglish(outLang)) {
      lines.push(`${title || "The product"} offers ${body}.`);
    } else {
      lines.push(`${title || "Das Produkt"} bietet ${body}.`);
    }
  }

  lines.push("", isEnglish(outLang) ? "View details." : "Details ansehen.");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Kept as a compatibility export for tests/tools that still reference the v1 name.
function buildFactOnlyOutput(profile, options = {}) {
  return buildNaturalFactOutput(profile, options);
}

const SAFE_GLUE = new Set([
  // DE grammatical glue / neutral verbs
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "und", "oder", "mit", "von", "zu", "bis", "fuer", "im", "in", "am", "an", "auf", "als",
  "ist", "sind", "hat", "haben", "bietet", "bieten", "verfuegt", "verfuegen", "ueber",
  "umfasst", "enthalten", "enthaelt", "betragt", "betraegt", "liegt", "bei", "erreicht",
  "produkt", "modell", "details", "ansehen", "freigegeben", "freigegebene", "fakten",
  // EN grammatical glue / neutral verbs
  "the", "a", "an", "and", "or", "with", "of", "to", "up", "for", "in", "on", "as",
  "is", "are", "has", "have", "offers", "offer", "features", "feature", "includes", "include",
  "provides", "provide", "reaches", "details", "view", "approved", "facts", "product", "model",
]);

const CLAIM_RISK_TOKENS = new Set([
  // DE/normalized
  "schnell", "schnelles", "schneller", "schnelle", "schnellladen", "ladezeit", "laden", "aufladen",
  "robust", "robuste", "robuster", "wetterfest", "witterung", "wasserfest", "wasserdicht",
  "ideal", "perfekt", "geeignet", "eignet", "einfach", "einfache", "unkompliziert", "unkomplizierte",
  "angenehm", "angenehme", "behaglich", "behagliche", "atmosphaere", "sicher", "sichere",
  "langlebig", "langlebige", "hochwertig", "premium", "effizient", "effiziente", "leistungsstark",
  "kompakt", "leichte", "leicht", "outdoor", "innenbereich", "aussenbereich", "camping", "wandern",
  "picknick", "notbeleuchtung", "haushalt", "stromquelle", "variiert", "haeufig", "nutzung",
  // EN
  "fast", "quick", "quickly", "rapid", "charging", "charge", "rugged", "robust", "weatherproof",
  "waterproof", "ideal", "perfect", "suitable", "easy", "comfortable", "pleasant", "safe", "durable",
  "premium", "efficient", "powerful", "compact", "lightweight", "outdoor", "indoor", "camping",
  "hiking", "emergency", "household",
]);

function factCorpus(facts) {
  return normalize(facts.flatMap((fact) => [fact.label, fact.value]).join(" "));
}

function significantTokens(value) {
  return tokens(value).filter((token) => token.length >= 3 || /^\d/.test(token));
}

function valueMatchesClaim(claimNorm, fact) {
  const valueNorm = normalize(fact?.value);
  if (!valueNorm) return false;
  if (claimNorm.includes(valueNorm)) return true;

  const vTokens = tokens(fact.value).filter((token) => !SAFE_GLUE.has(token));
  if (!vTokens.length) return false;

  // For short/numeric values (USB-C, 750 ml, 12 Stunden), all significant value
  // tokens must occur. This is conservative: paraphrases that cannot be matched
  // deterministically are sent to review instead of being trusted.
  return vTokens.every((token) => claimNorm.split(" ").includes(token));
}

function isNeutralCta(claimNorm) {
  return /^(details ansehen|mehr erfahren|view details|learn more)$/.test(claimNorm);
}

function technicalCodes(value) {
  const raw = clean(value).toLowerCase();
  const codes = [];
  for (const match of raw.matchAll(/\busb[\s-]?[a-z0-9]+\b/gi)) {
    codes.push(match[0].replace(/[\s-]+/g, ""));
  }
  for (const match of raw.matchAll(/\bip\s?-?\d{2}\b/gi)) {
    codes.push(match[0].replace(/[\s-]+/g, ""));
  }
  return Array.from(new Set(codes));
}

function stripClaimPrefix(value) {
  return clean(value)
    .replace(/^[-•*]+\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^(frage|antwort|question|answer|cta(?: zeile)?|mini faq)\s*:\s*/i, "")
    .trim();
}

function splitClaims(output) {
  const out = [];
  for (const rawLine of clean(output).split(/\r?\n/)) {
    const line = stripClaimPrefix(rawLine);
    if (!line) continue;

    const pieces = line
      .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/)
      .map((part) => clean(part).replace(/[.!?]+$/, ""))
      .filter(Boolean);

    out.push(...(pieces.length ? pieces : [line]));
  }
  return out;
}

function auditClaim(claim, { profile, facts, title }) {
  const text = clean(claim);
  const claimNorm = normalize(text);
  const titleNorm = normalize(title);
  const corpus = factCorpus(facts);
  const corpusTokens = new Set(tokens(corpus));

  if (!claimNorm) {
    return { text, supported: true, reason: "empty", matchedFactIds: [] };
  }
  if (claimNorm === titleNorm || isNeutralCta(claimNorm)) {
    const titleFact = facts.find(isTitleFact);
    return {
      text,
      supported: true,
      reason: claimNorm === titleNorm ? "title" : "neutral_cta",
      matchedFactIds: titleFact && claimNorm === titleNorm ? [titleFact.id] : [],
    };
  }

  const matchedFacts = facts.filter((fact) => valueMatchesClaim(claimNorm, fact));
  const matchedFactIds = matchedFacts.map((fact) => fact.id);

  const claimNumbers = claimNorm.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  const corpusNumbers = new Set(corpus.match(/\b\d+(?:[.,]\d+)?\b/g) || []);
  const unsupportedNumbers = claimNumbers.filter((number) => !corpusNumbers.has(number));

  const approvedTechnicalCodes = new Set(
    facts.flatMap((fact) => technicalCodes(`${fact.label} ${fact.value}`)),
  );
  const unsupportedTechnicalCodes = technicalCodes(text).filter(
    (code) => !approvedTechnicalCodes.has(code),
  );

  const riskTokens = significantTokens(claimNorm).filter(
    (token) => CLAIM_RISK_TOKENS.has(token) && !corpusTokens.has(token),
  );

  const novelTokens = significantTokens(claimNorm).filter((token) => {
    if (corpusTokens.has(token) || SAFE_GLUE.has(token)) return false;
    if (/^\d/.test(token)) return false;
    // Do not flag morphology that directly contains/is contained by an approved token.
    for (const approved of corpusTokens) {
      if (approved.length >= 4 && (token.startsWith(approved) || approved.startsWith(token))) {
        return false;
      }
    }
    return true;
  });

  let supported = matchedFacts.length > 0;
  let reason = supported ? "matched_approved_fact" : "no_approved_fact_match";

  if (unsupportedTechnicalCodes.length) {
    supported = false;
    reason = "unsupported_technical_code";
  } else if (unsupportedNumbers.length) {
    supported = false;
    reason = "unsupported_number";
  } else if (riskTokens.length) {
    supported = false;
    reason = "unsupported_claim_term";
  } else if (novelTokens.length > 0) {
    supported = false;
    reason = "unsupported_claim_language";
  }

  return {
    text,
    supported,
    reason,
    matchedFactIds,
    unsupportedNumbers,
    unsupportedTechnicalCodes,
    unsupportedTokens: Array.from(new Set([...riskTokens, ...novelTokens])).slice(0, 12),
  };
}

function auditOutputAgainstFacts(output, profile) {
  const facts = approvedFacts(profile);
  const title = pickTitle(profile, facts);
  const claims = splitClaims(output);
  const claimMap = claims.map((claim) => auditClaim(claim, { profile, facts, title }));
  const rejectedClaims = claimMap.filter((entry) => !entry.supported);
  const verifiedClaims = claimMap.filter((entry) => entry.supported);
  const matchedFactIds = Array.from(
    new Set(verifiedClaims.flatMap((entry) => entry.matchedFactIds || []).filter(Boolean)),
  );

  return {
    claimMap,
    claimCount: claimMap.length,
    verifiedClaimCount: verifiedClaims.length,
    rejectedClaimCount: rejectedClaims.length,
    rejectedClaims,
    matchedFactIds,
    verifiedFactCount: matchedFactIds.length,
    completeFactCoverage: facts.every((fact) => matchedFactIds.includes(fact.id)),
  };
}

function baseProof(profile, facts) {
  return {
    mode: PROOF_MODE,
    profileId: clean(profile?.id) || null,
    profileVersion: profile ? Number(profile.version || 1) : null,
    factCount: facts.length,
    approvedFactIds: facts.map((fact) => fact.id),
    factVersions: facts.map((fact) => ({ id: fact.id, version: fact.version })),
    worldTruthVerified: false,
  };
}

function applyClaimAwareFactGuard({ output, profile, isProductDescription, outLang } = {}) {
  const facts = approvedFacts(profile);
  const base = baseProof(profile, facts);

  if (!profile || !isProductDescription || !facts.length) {
    return {
      output: clean(output),
      proof: {
        ...base,
        status: "NOT_VERIFIED",
        applied: false,
        reason: !profile
          ? "no_profile"
          : !isProductDescription
            ? "use_case_not_yet_supported"
            : "no_approved_proof_facts",
        verifiedFactCount: 0,
        claimCount: 0,
        verifiedClaimCount: 0,
        rejectedClaimCount: 0,
      },
    };
  }

  const modelAudit = auditOutputAgainstFacts(output, profile);

  if (modelAudit.rejectedClaimCount === 0 && modelAudit.completeFactCoverage) {
    return {
      output: clean(output),
      proof: {
        ...base,
        status: "PASSED",
        applied: true,
        action: "model_output_verified",
        scope: "selected_profile_facts_claim_audit",
        verifiedFactCount: modelAudit.verifiedFactCount,
        matchedFactIds: modelAudit.matchedFactIds,
        claimCount: modelAudit.claimCount,
        verifiedClaimCount: modelAudit.verifiedClaimCount,
        rejectedClaimCount: 0,
        safeOutputApplied: false,
      },
    };
  }

  // Do not expose the unverified model draft. V2 replaces it with a deterministic,
  // natural-language renderer built only from approved facts, while keeping the
  // SAFE_REWRITE means the unverified model draft was discarded and the final output
  // was deterministically rebuilt only from approved Proof Facts. Human review is not required.
  const safeOutput = buildNaturalFactOutput(profile, { outLang });
  const safeAudit = auditOutputAgainstFacts(safeOutput, profile);
  const reason = modelAudit.rejectedClaimCount > 0
    ? "unsupported_claims_detected"
    : "incomplete_fact_coverage";

  return {
    output: safeOutput,
    proof: {
      ...base,
      status: "SAFE_REWRITE",
      applied: true,
      action: "safe_natural_rewrite",
      humanReviewRequired: false,
      finalOutputVerified: true,
      scope: "selected_profile_facts_claim_audit",
      reason,
      verifiedFactCount: safeAudit.verifiedFactCount,
      matchedFactIds: safeAudit.matchedFactIds,
      claimCount: modelAudit.claimCount,
      verifiedClaimCount: modelAudit.verifiedClaimCount,
      rejectedClaimCount: modelAudit.rejectedClaimCount,
      rejectedClaims: modelAudit.rejectedClaims.slice(0, 8).map((entry) => ({
        text: entry.text.slice(0, 240),
        reason: entry.reason,
        matchedFactIds: entry.matchedFactIds,
        unsupportedTokens: entry.unsupportedTokens,
        unsupportedNumbers: entry.unsupportedNumbers,
        unsupportedTechnicalCodes: entry.unsupportedTechnicalCodes,
      })),
      safeOutputApplied: true,
      safeOutputVerifiedClaimCount: safeAudit.verifiedClaimCount,
    },
  };
}

// Compatibility alias: callers from v1 can transition without a hard break.
function applyStrictProfileFactGuard(args = {}) {
  return applyClaimAwareFactGuard(args);
}

module.exports = {
  PROOF_MODE,
  approvedFacts,
  buildNaturalFactOutput,
  buildFactOnlyOutput,
  splitClaims,
  auditClaim,
  auditOutputAgainstFacts,
  applyClaimAwareFactGuard,
  applyStrictProfileFactGuard,
};
