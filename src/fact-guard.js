"use strict";

const PROOF_MODE = "strict-profile-facts-v1";

function clean(value) {
  return String(value ?? "").trim();
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
  return clean(titleFact?.value || profile?.brandName || profile?.name || "");
}

function buildFactOnlyOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";

  const titleFact = facts.find(isTitleFact) || null;
  const title = pickTitle(profile, facts);
  const bodyFacts = titleFact ? facts.filter((fact) => fact.id !== titleFact.id) : facts;
  const lines = [];

  if (title) lines.push(title, "");
  for (const fact of bodyFacts) {
    lines.push(`- ${fact.label}: ${fact.value}`);
  }

  const lang = clean(outLang).toLowerCase();
  lines.push("", lang.startsWith("en") ? "View details." : "Details ansehen.");
  return lines.join("\n").trim();
}

function applyStrictProfileFactGuard({ output, profile, isProductDescription, outLang } = {}) {
  const facts = approvedFacts(profile);

  if (!profile || !isProductDescription || !facts.length) {
    return {
      output: clean(output),
      proof: {
        status: "NOT_VERIFIED",
        mode: PROOF_MODE,
        applied: false,
        reason: !profile
          ? "no_profile"
          : !isProductDescription
            ? "use_case_not_yet_supported"
            : "no_approved_proof_facts",
        factCount: facts.length,
        approvedFactIds: facts.map((fact) => fact.id),
      },
    };
  }

  // Strict v1 deliberately does not trust model-written product claims.
  // The final user-visible output is rendered only from approved structured facts.
  // This proves alignment to the selected profile facts, not truth about the world.
  const safeOutput = buildFactOnlyOutput(profile, { outLang });

  return {
    output: safeOutput,
    proof: {
      status: "PASSED",
      mode: PROOF_MODE,
      applied: true,
      action: "fact_only_render",
      scope: "selected_profile_facts_only",
      profileId: clean(profile.id) || null,
      profileVersion: Number(profile.version || 1),
      factCount: facts.length,
      approvedFactIds: facts.map((fact) => fact.id),
      factVersions: facts.map((fact) => ({ id: fact.id, version: fact.version })),
      worldTruthVerified: false,
    },
  };
}

module.exports = {
  PROOF_MODE,
  approvedFacts,
  buildFactOnlyOutput,
  applyStrictProfileFactGuard,
};
