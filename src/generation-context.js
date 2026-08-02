"use strict";

const {
  ProfileError,
  getAccountProfile,
  buildProfilePromptBlock,
} = require("./profiles");

function getRequestedProfileId(body) {
  const b = body || {};
  return String(
    b.profileId ??
      b.profile_id ??
      b.contextProfileId ??
      b.context_profile_id ??
      "",
  ).trim();
}

function resolveGenerationProfile(account, body) {
  const profileId = getRequestedProfileId(body);
  if (!profileId) return null;

  const profile = getAccountProfile(account, profileId);
  if (!profile) {
    throw new ProfileError("profile_not_found", "profile not found", 404, {
      profileId,
    });
  }

  return profile;
}

function buildGroundingPromptBlock({ profile = null, useCase = "", outLang = "DE" } = {}) {
  const parts = [
    "[GLE_GROUNDING_RULES_V2]",
    "Grounding rules for the final content:",
    "- Treat the user's THEMA and FORMAT / Anforderungen as the source of truth for project-, company-, product-, service- and experience-specific facts.",
    "- Do not invent product features, prices, availability, customer feedback, employee results, measured outcomes, timelines, studies, sources, certifications, health effects or performance claims that the user did not provide.",
    "- If the user says they want to share experiences/results but gives no actual results, do not fabricate them. Write a neutral framing, process, questions, checkpoints or placeholders only when the requested format permits it.",
    "- General background knowledge may be used for genuinely educational content, but never disguise a guess about the user's own organization/product/project as a known fact.",
    "- For health, legal or financial topics, keep unsupported claims cautious and do not invent sources or certainty.",
    "- If a required project-specific fact is missing, omit the claim rather than guessing.",
  ];

  if (profile) {
    parts.push(
      "[GLE_GROUNDED_DRAFT_RULES_V275]",
      "- The selected Magic Context profile follows below.",
      "- CRITICAL PROOF BOUNDARY: only entries listed under 'Approved profile facts' may be asserted as factual claims about the product, company or project.",
      "- Brand/Client, Audience, Voice and Context are editorial metadata. They may guide naming, tone or intended readership, but they are NOT approved factual claims.",
      "- Never turn Audience metadata into a product suitability/use-case claim. Example: Audience='Outdoor users' does NOT mean the product is 'for outdoor use', 'ideal for camping' or an 'outdoor product' unless that statement is also an Approved profile fact.",
      "- Do not turn Voice or Context metadata into a product feature, benefit, performance or quality claim.",
      "- Do not contradict approved profile facts. Do not infer additional profile-specific facts beyond the Approved profile facts.",
      "- Natural wording is allowed, but every factual product/company/project claim must be directly supported by one or more Approved profile facts.",
      "- Neutral grammatical relation wording is allowed only when it preserves the approved fact relation; for example, if Anschluss=USB-C is approved, 'Der Anschluss erfolgt über USB-C.' is acceptable, but do not generalize this wording into a new capability or benefit.",
      "- Approved profile facts are a source pool, not a checklist. Use only the facts relevant to the requested format; do not force every approved fact into every output.",
      "- Do not add benefits, suitability, performance, quality adjectives, use cases, causal effects or implications unless they are explicitly Approved profile facts.",
      "- Avoid unsupported marketing adjectives such as perfect, ideal, robust, premium, versatile, fast, convenient or similar claims unless explicitly approved.",
      "- A sentence that mixes an approved fact with an unsupported claim is still unsafe. Remove the unsupported part instead of keeping the whole sentence.",
      "- Neutral headings, engagement questions and non-transactional CTAs are allowed only when they add no new product/company/project claim.",
      "- Do not add hashtags that imply unapproved benefits or use cases. A hashtag may only repeat an approved name or approved fact value.",
      "- Do not echo command words from THEMA / FORMAT (for example 'create', 'short', 'post') as factual content.",
      "- Before finalizing, silently audit each factual sentence against the Approved profile facts. If a factual assertion is not directly supported, delete it rather than guessing or softening it.",
      "- Prefer concise natural wording over explanatory filler.",
    );

    const useCaseNorm = String(useCase || "").trim().toLowerCase();
    const isSocial =
      (useCaseNorm.includes("social") && useCaseNorm.includes("post")) ||
      useCaseNorm === "social media post";

    if (isSocial) {
      const isEnglish = String(outLang || "").toLowerCase() === "en";
      parts.push(
        "[GLE_SOCIAL_GROUNDED_DRAFT_V275]",
        isEnglish
          ? "- Output exactly 7 non-empty lines."
          : "- Gib exakt 7 nicht-leere Zeilen aus.",
        isEnglish
          ? "- Line 1: a neutral hook using only the approved product/name context; no benefit, suitability or hype claim."
          : "- Zeile 1: neutraler Hook nur auf Basis freigegebener Produkt-/Namensangaben; kein Nutzen-, Eignungs- oder Hype-Claim.",
        isEnglish
          ? "- Line 2: one factual sentence supported only by Approved profile facts."
          : "- Zeile 2: genau ein sachlicher Satz, ausschließlich durch Approved profile facts gedeckt.",
        isEnglish
          ? "- Lines 3-5: exactly three bullet lines, each repeating an Approved profile fact without adding interpretation."
          : "- Zeilen 3-5: exakt drei Bullet-Zeilen, jeweils ein Approved profile fact ohne zusätzliche Interpretation.",
        isEnglish
          ? "- If fewer than three distinct approved body facts exist, reuse only approved information rather than inventing a new fact."
          : "- Wenn weniger als drei unterschiedliche freigegebene Sachfakten vorhanden sind, verwende nur freigegebene Angaben erneut statt einen neuen Fakt zu erfinden.",
        isEnglish
          ? "- Line 6: a neutral engagement question that introduces no new product claim."
          : "- Zeile 6: neutrale Interaktionsfrage ohne neuen Produkt-Claim.",
        isEnglish
          ? "- Prefer one of these safe question patterns: 'Which point interests you most?' or 'Which detail interests you most?'."
          : "- Bevorzuge eine dieser sicheren Frageformen: 'Welcher Punkt interessiert Sie am meisten?' oder 'Welches Detail interessiert Sie am meisten?'.",
        isEnglish
          ? "- Do not ask how the product fits into, integrates into or supports the reader's activities unless that use case is an Approved profile fact."
          : "- Frage nicht, wie sich das Produkt in Aktivitäten integrieren lässt oder diese unterstützt, sofern dieser Anwendungsfall kein Approved profile fact ist.",
        isEnglish
          ? "- Line 7: a neutral non-transactional CTA."
          : "- Zeile 7: neutrale, nicht-transaktionale CTA.",
        isEnglish
          ? "- Prefer CTA wording such as 'View details.' or 'Learn more.'; if an approved product name is used, 'View [approved name] details.' is also allowed."
          : "- Bevorzuge CTA-Formulierungen wie 'Details ansehen.' oder 'Mehr erfahren.'; mit freigegebenem Produktnamen ist auch 'Details zu [freigegebener Name] ansehen.' erlaubt.",
        "- Never use Audience metadata as a Social claim.",
        "- Do not infer physical attributes such as compact, lightweight, portable or easy to transport unless they are Approved profile facts.",
        "- No unsupported hashtags, use cases, benefits or quality adjectives.",
        "[END_GLE_SOCIAL_GROUNDED_DRAFT_V275]",
      );
    }

    parts.push(
      buildProfilePromptBlock(profile),
      "[END_GLE_GROUNDED_DRAFT_RULES_V275]",
    );
  }

  parts.push(
    "Keep the originally requested output format exactly.",
    "[END_GLE_GROUNDING_RULES_V2]",
  );

  return parts.join("\n");
}

module.exports = {
  getRequestedProfileId,
  resolveGenerationProfile,
  buildGroundingPromptBlock,
};
