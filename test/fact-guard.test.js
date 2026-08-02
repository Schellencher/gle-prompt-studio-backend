"use strict";

const assert = require("assert");
const { createAccountProfile } = require("../src/profiles");
const {
  PROOF_MODE,
  buildNaturalFactOutput,
  buildLandingFactOutput,
  buildSocialFactOutput,
  buildLinkedInFactOutput,
  buildEmailFactOutput,
  buildBlogFactOutput,
  buildShortVideoFactOutput,
  auditOutputAgainstFacts,
  applyClaimAwareFactGuard,
} = require("../src/fact-guard");

const account = { accountId: "acc_fact_guard_v2", profiles: [] };
const profile = createAccountProfile(
  account,
  {
    name: "Magic Context Test",
    kind: "project",
    brandName: "TrailFold",
    proofFacts: [
      { label: "Produktname", value: "TrailFold 12" },
      { label: "Anschluss", value: "USB-C" },
      { label: "Lichtfarbe", value: "warmweiß" },
      { label: "Akkulaufzeit", value: "bis zu 12 Stunden" },
    ],
  },
  { nowTs: 1000 },
);

assert.equal(PROOF_MODE, "claim-aware-profile-facts-v2");

const safe = buildNaturalFactOutput(profile, { outLang: "DE" });
assert(safe.startsWith("TrailFold 12"));
assert(safe.includes("USB-C"));
assert(safe.includes("warmweiß"));
assert(safe.includes("bis zu 12 Stunden"));
assert(safe.endsWith("Details zu TrailFold 12 ansehen."));
assert(!safe.toLowerCase().includes("schnell"));
assert(!safe.toLowerCase().includes("robust"));
assert(!safe.toLowerCase().includes("wetter"));
assert(!safe.toLowerCase().includes("kompakt"));

const safeAudit = auditOutputAgainstFacts(safe, profile);
assert.equal(safeAudit.rejectedClaimCount, 0);
assert.equal(safeAudit.completeFactCoverage, true);
assert.equal(safeAudit.verifiedFactCount, 4);

const cleanNaturalModelOutput = `TrailFold 12\n\nTrailFold 12 bietet einen USB-C-Anschluss, warmweißes Licht und eine Akkulaufzeit von bis zu 12 Stunden.\n\nDetails ansehen.`;
const passed = applyClaimAwareFactGuard({
  output: cleanNaturalModelOutput,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(passed.proof.status, "PASSED");
assert.equal(passed.proof.mode, PROOF_MODE);
assert.equal(passed.proof.action, "model_output_verified");
assert.equal(passed.proof.rejectedClaimCount, 0);
assert.equal(passed.proof.verifiedFactCount, 4);
assert.equal(passed.proof.safeOutputApplied, false);
assert.equal(passed.output, cleanNaturalModelOutput);

const hallucinatedModelOutput = `TrailFold 12\n\n- USB-C Anschluss für schnelles Laden\n- Warmweißes Licht schafft eine angenehme Atmosphäre\n- Akkulaufzeit bis zu 12 Stunden\n- Robuste Bauweise für den Außeneinsatz\n- Kompakt und leicht für einfache Mitnahme\n\nDetails ansehen.`;
const reviewed = applyClaimAwareFactGuard({
  output: hallucinatedModelOutput,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(reviewed.proof.status, "SAFE_REWRITE");
assert.equal(reviewed.proof.mode, PROOF_MODE);
assert.equal(reviewed.proof.action, "safe_natural_rewrite");
assert.equal(reviewed.proof.reason, "unsupported_claims_detected");
assert(reviewed.proof.rejectedClaimCount >= 3);
assert.equal(reviewed.proof.safeOutputApplied, true);
assert.equal(reviewed.proof.humanReviewRequired, false);
assert.equal(reviewed.proof.finalOutputVerified, true);
assert.equal(reviewed.proof.verifiedFactCount, 4);
assert.equal(reviewed.output, safe);
assert(!reviewed.output.toLowerCase().includes("schnell"));
assert(!reviewed.output.toLowerCase().includes("robust"));
assert(!reviewed.output.toLowerCase().includes("wetter"));
assert(!reviewed.output.toLowerCase().includes("kompakt"));
assert(reviewed.proof.rejectedClaims.some((claim) => /schnell/i.test(claim.text)));

const wrongConnector = applyClaimAwareFactGuard({
  output: `TrailFold 12\n\nTrailFold 12 bietet einen USB-A-Anschluss, warmweißes Licht und eine Akkulaufzeit von bis zu 12 Stunden.`,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(wrongConnector.proof.status, "SAFE_REWRITE");
assert(wrongConnector.proof.rejectedClaimCount >= 1);

const inventedNumber = applyClaimAwareFactGuard({
  output: `TrailFold 12\n\nTrailFold 12 bietet USB-C und lädt in 2 Stunden.`,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(inventedNumber.proof.status, "SAFE_REWRITE");
assert(inventedNumber.proof.rejectedClaims.some((claim) => claim.reason === "unsupported_number"));

const incomplete = applyClaimAwareFactGuard({
  output: `TrailFold 12\n\nTrailFold 12 bietet einen USB-C-Anschluss.\n\nDetails ansehen.`,
  profile,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(incomplete.proof.status, "SAFE_REWRITE");
assert.equal(incomplete.proof.reason, "incomplete_fact_coverage");
assert.equal(incomplete.output, safe);

const noProfile = applyClaimAwareFactGuard({
  output: "Normaler Output",
  profile: null,
  isProductDescription: true,
  outLang: "DE",
});
assert.equal(noProfile.proof.status, "NOT_VERIFIED");
assert.equal(noProfile.proof.reason, "no_profile");
assert.equal(noProfile.output, "Normaler Output");

const unsupportedUseCase = applyClaimAwareFactGuard({
  output: "LinkedIn output",
  profile,
  isProductDescription: false,
  outLang: "DE",
});
assert.equal(unsupportedUseCase.proof.status, "NOT_VERIFIED");
assert.equal(unsupportedUseCase.proof.reason, "use_case_not_yet_supported");
assert.equal(unsupportedUseCase.output, "LinkedIn output");



const safeLanding = buildLandingFactOutput(profile, { outLang: "DE" });
assert(safeLanding.startsWith("TrailFold 12"));
assert(safeLanding.includes("zentralen Produktangaben auf einen Blick"));
assert(safeLanding.includes("Produktdetails"));
assert(safeLanding.includes("- USB-C-Anschluss"));
assert(safeLanding.includes("- Warmweißes Licht"));
assert(safeLanding.includes("- Akkulaufzeit bis zu 12 Stunden"));
assert(safeLanding.includes("Details zu TrailFold 12 ansehen."));
assert(safeLanding.includes("FAQ"));
assert(safeLanding.includes("Welchen Anschluss hat TrailFold 12?"));
assert(safeLanding.includes("Welche Lichtfarbe bietet TrailFold 12?"));
assert(safeLanding.includes("Wie lange beträgt die Akkulaufzeit?"));
assert(!safeLanding.includes("CTA-Zeile"));
assert(!safeLanding.includes("Bulletpoints:"));
assert(!safeLanding.includes("Mini-FAQ"));
assert(!safeLanding.toLowerCase().includes("freigegeben"));
assert(!safeLanding.toLowerCase().includes("schnell"));
assert(!safeLanding.toLowerCase().includes("robust"));

const safeLandingAudit = auditOutputAgainstFacts(safeLanding, profile);
assert.equal(safeLandingAudit.rejectedClaimCount, 0);
assert.equal(safeLandingAudit.completeFactCoverage, true);
assert.equal(safeLandingAudit.verifiedFactCount, 4);

const cleanLandingModelOutput = `1) TrailFold 12\n2) TrailFold 12 bietet einen USB-C-Anschluss, warmweißes Licht und eine Akkulaufzeit von bis zu 12 Stunden.\n3) Bulletpoints:\n- Produktname: TrailFold 12\n- Anschluss: USB-C\n- Lichtfarbe: warmweiß\n- Akkulaufzeit: bis zu 12 Stunden\n4) CTA-Zeile: Details ansehen.\n5) Mini-FAQ:\n- Frage: Welche Angabe ist für Anschluss freigegeben?\n  Antwort: Anschluss: USB-C.\n- Frage: Welche Angabe ist für Lichtfarbe freigegeben?\n  Antwort: Lichtfarbe: warmweiß.\n- Frage: Welche Angabe ist für Akkulaufzeit freigegeben?\n  Antwort: Akkulaufzeit: bis zu 12 Stunden.`;
const landingPassed = applyClaimAwareFactGuard({
  output: cleanLandingModelOutput,
  profile,
  isProductDescription: false,
  isLandingPage: true,
  outLang: "DE",
});
assert.equal(landingPassed.proof.status, "PASSED");
assert.equal(landingPassed.proof.useCaseScope, "landingpage_ad_copy");
assert.equal(landingPassed.proof.rejectedClaimCount, 0);
assert.equal(landingPassed.proof.verifiedFactCount, 4);
assert.equal(landingPassed.proof.safeOutputApplied, false);
assert.equal(landingPassed.output, cleanLandingModelOutput);

const hallucinatedLanding = `1) TrailFold 12 – die perfekte Campinglampe\n2) Robuste Outdoor-Lampe mit schnellem USB-C-Laden und 12 Stunden Akkulaufzeit.\n3) Bulletpoints:\n- Wasserdicht für jedes Wetter\n- USB-C Schnellladen\n- Warmweißes Licht\n- Bis zu 12 Stunden Akkulaufzeit\n- Leicht und kompakt\n4) CTA-Zeile: Jetzt kaufen.\n5) Mini-FAQ:\n- Frage: Ist sie wasserdicht?\n  Antwort: Ja, sie ist für jedes Wetter geeignet.`;
const landingRewritten = applyClaimAwareFactGuard({
  output: hallucinatedLanding,
  profile,
  isProductDescription: false,
  isLandingPage: true,
  outLang: "DE",
});
assert.equal(landingRewritten.proof.status, "SAFE_REWRITE");
assert.equal(landingRewritten.proof.action, "safe_landing_rewrite");
assert.equal(landingRewritten.proof.useCaseScope, "landingpage_ad_copy");
assert.equal(landingRewritten.proof.safeOutputApplied, true);
assert.equal(landingRewritten.proof.humanReviewRequired, false);
assert.equal(landingRewritten.proof.finalOutputVerified, true);
assert.equal(landingRewritten.proof.verifiedFactCount, 4);
assert.equal(landingRewritten.output, safeLanding);
assert(!landingRewritten.output.toLowerCase().includes("wasserdicht"));
assert(!landingRewritten.output.toLowerCase().includes("perfekt"));
assert(!landingRewritten.output.toLowerCase().includes("robust"));
assert(!landingRewritten.output.toLowerCase().includes("schnellladen"));



// v2.3 full Studio coverage ---------------------------------------------------
function assertSafeRewriteResult(result, expectedScope, expectedAction) {
  assert.equal(result.proof.status, "SAFE_REWRITE");
  assert.equal(result.proof.useCaseScope, expectedScope);
  assert.equal(result.proof.action, expectedAction);
  assert.equal(result.proof.safeOutputApplied, true);
  assert.equal(result.proof.humanReviewRequired, false);
  assert.equal(result.proof.finalOutputVerified, true);
  assert.equal(result.proof.verifiedFactCount, 4);
  assert.equal(result.proof.safeOutputRejectedClaimCount, 0);
  assert(!result.output.toLowerCase().includes("robust"));
  assert(!result.output.toLowerCase().includes("camping"));
  assert(!result.output.toLowerCase().includes("wandern"));
  assert(!result.output.toLowerCase().includes("schnell"));
  assert(!result.output.toLowerCase().includes("vielseitig"));
  assert(!result.output.toLowerCase().includes("angenehme atmosphäre"));
}

const safeSocial = buildSocialFactOutput(profile, { outLang: "DE" });
assert.equal(safeSocial.split("\n").length, 7);
assert(safeSocial.includes("TrailFold 12"));
assert(safeSocial.includes("USB-C"));
assert(safeSocial.includes("warmweiß"));
assert(safeSocial.includes("bis zu 12 Stunden"));
assert(safeSocial.includes("Mehr zu TrailFold 12:"));
assert(safeSocial.endsWith("Details ansehen."));
const safeSocialAudit = auditOutputAgainstFacts(safeSocial, profile);
assert.equal(safeSocialAudit.rejectedClaimCount, 0);
assert.equal(safeSocialAudit.completeFactCoverage, true);

const badSocial = `Erstelle eine kurze Landingpage für das ausgewählte Produkt.: das Wichtigste auf einen Blick.
Eine klare Struktur hilft, bekannte Informationen und offene Fragen sauber zu trennen.
- Den zentralen Punkt in den Fokus stellen.
- Aussagen an die vorhandenen Angaben binden.
- Fakten und Annahmen klar voneinander trennen.
- Nicht belegte Details weglassen.
Mehr zum Thema erfahren.`;
const socialRewritten = applyClaimAwareFactGuard({
  output: badSocial,
  profile,
  isSocial: true,
  isProductDescription: false,
  outLang: "DE",
});
assertSafeRewriteResult(socialRewritten, "social_media_post", "safe_social_rewrite");
assert.equal(socialRewritten.output, safeSocial);
assert.equal(socialRewritten.output.split("\n").length, 7);

const safeLinkedIn = buildLinkedInFactOutput(profile, { outLang: "DE" });
const safeLinkedInAudit = auditOutputAgainstFacts(safeLinkedIn, profile);
assert.equal(safeLinkedInAudit.rejectedClaimCount, 0);
assert.equal(safeLinkedInAudit.completeFactCoverage, true);
assert(safeLinkedIn.includes("Was sind die zentralen Produktangaben?"));
assert(safeLinkedIn.includes("an einer Stelle zusammengefasst"));
const badLinkedIn = `TrailFold 12 – Produktbeschreibung

1) Produktname: TrailFold 12
Kompaktes Outdoor-Produkt für vielseitige Anwendungen.

2) Anschluss: USB-C
Moderne Verbindung für einfache Handhabung.

3) Lichtfarbe: warmweiß
Angenehme Lichtfarbe für entspannte Atmosphäre.

4) Akkulaufzeit: bis zu 12 Stunden
Langanhaltende Nutzung ohne häufiges Aufladen.

Details anzeigen.`;
const linkedInRewritten = applyClaimAwareFactGuard({
  output: badLinkedIn,
  profile,
  isLinkedInPost: true,
  isProductDescription: true, // proves explicit use-case wins over broad product detector
  outLang: "DE",
});
assertSafeRewriteResult(linkedInRewritten, "linkedin_post", "safe_linkedin_rewrite");
assert.equal(linkedInRewritten.output, safeLinkedIn);

const safeEmail = buildEmailFactOutput(profile, { outLang: "DE" });
const safeEmailAudit = auditOutputAgainstFacts(safeEmail, profile);
assert.equal(safeEmailAudit.rejectedClaimCount, 0);
assert.equal(safeEmailAudit.completeFactCoverage, true);
assert(safeEmail.startsWith("Betreff: TrailFold 12"));
assert(safeEmail.includes("Hallo,"));
assert(safeEmail.endsWith("Viele Grüße"));
const weakEmail = `Produktbeschreibung: TrailFold 12

1) Produktname: TrailFold 12
2) Anschluss: USB-C
3) Lichtfarbe: warmweiß
4) Akkulaufzeit: bis zu 12 Stunden

Details ansehen.`;
const emailRewritten = applyClaimAwareFactGuard({
  output: weakEmail,
  profile,
  isEmailPost: true,
  outLang: "DE",
});
// The factual list itself may pass the claim audit. The safe renderer is exercised directly
// and unsafe email claims are exercised below.
const badEmail = `Betreff: TrailFold 12 für lange Outdoor-Abende

Hallo,
TrailFold 12 ist die ideale robuste Lampe für Camping und Wandern. USB-C ermöglicht schnelles Aufladen und die Akkulaufzeit beträgt bis zu 12 Stunden.

Jetzt kaufen.`;
const emailUnsafe = applyClaimAwareFactGuard({
  output: badEmail,
  profile,
  isEmailPost: true,
  outLang: "DE",
});
assertSafeRewriteResult(emailUnsafe, "email", "safe_email_rewrite");
assert.equal(emailUnsafe.output, safeEmail);

const safeBlog = buildBlogFactOutput(profile, { outLang: "DE" });
const safeBlogAudit = auditOutputAgainstFacts(safeBlog, profile);
assert.equal(safeBlogAudit.rejectedClaimCount, 0);
assert.equal(safeBlogAudit.completeFactCoverage, true);
assert(safeBlog.includes("Produktangaben im Überblick"));
assert(safeBlog.includes("Im Detail"));
assert(safeBlog.includes("Kurz zusammengefasst"));
const badBlog = `Produktbeschreibung: TrailFold 12

TrailFold 12 ist ein vielseitiges Outdoor-Produkt, das für verschiedene Anwendungen konzipiert wurde.
Das Gerät verfügt über einen USB-C-Anschluss, der eine einfache und schnelle Verbindung ermöglicht.
Die Lichtfarbe ist warmweiß, was eine angenehme Atmosphäre schafft.
Mit einer Akkulaufzeit von bis zu 12 Stunden eignet sich das Produkt ideal für längere Outdoor-Aktivitäten.

Mehr erfahren.`;
const blogRewritten = applyClaimAwareFactGuard({
  output: badBlog,
  profile,
  isBlogArticle: true,
  outLang: "DE",
});
assertSafeRewriteResult(blogRewritten, "blog_article", "safe_blog_rewrite");
assert.equal(blogRewritten.output, safeBlog);

const safeVideo = buildShortVideoFactOutput(profile, { outLang: "DE" });
const safeVideoAudit = auditOutputAgainstFacts(safeVideo, profile);
assert.equal(safeVideoAudit.rejectedClaimCount, 0);
assert.equal(safeVideoAudit.completeFactCoverage, true);
assert(safeVideo.includes("HOOK"));
assert(safeVideo.includes("SZENE 1"));
assert(safeVideo.includes("Sprecher:"));
assert(safeVideo.includes("OUTRO"));
assert(!safeVideo.includes("CTA-Zeile:"));
const badVideo = `Produktbeschreibung für TrailFold 12

1) Produktname: TrailFold 12, tragbare Lichtquelle für Outdoor-Aktivitäten.
2) Anschluss: USB-C Anschluss für einfache Verbindung und Aufladung.
3) Lichtfarbe: Warmweiß für angenehme Beleuchtung in der Natur.
4) Akkulaufzeit: Bis zu 12 Stunden, ideal für längere Ausflüge.
5) Zielgruppe: Outdoor-Enthusiasten, die eine praktische Lichtquelle suchen.
6) Anwendung: Geeignet für Camping, Wandern und abendliche Aktivitäten im Freien.

CTA-Zeile: Details abrufen.`;
const videoRewritten = applyClaimAwareFactGuard({
  output: badVideo,
  profile,
  isShortVideoScript: true,
  outLang: "DE",
});
assertSafeRewriteResult(videoRewritten, "short_video_script", "safe_video_rewrite");
assert.equal(videoRewritten.output, safeVideo);

// v2.4 quality sweep: native safe outputs stay clean, distinct and customer-facing.
for (const output of [safe, safeLanding, safeSocial, safeLinkedIn, safeEmail, safeBlog, safeVideo]) {
  const lower = output.toLowerCase();
  assert(!lower.includes("freigegeben"));
  assert(!lower.includes("proof fact"));
  assert(!lower.includes("annahmen"));
  assert(!lower.includes("cta-zeile"));
  assert(!lower.includes("bulletpoints:"));
  assert(!lower.includes("mini-faq"));
}
assert(safeEmail.includes("hier findest du die zentralen Angaben zu TrailFold 12:"));
assert(safeVideo.includes("Sprecher: Drei Produktangaben auf einen Blick."));

// Clean native output is still allowed through unchanged for the newly supported scopes.
const socialPassed = applyClaimAwareFactGuard({
  output: safeSocial,
  profile,
  isSocial: true,
  outLang: "DE",
});
assert.equal(socialPassed.proof.status, "PASSED");
assert.equal(socialPassed.output, safeSocial);


console.log("GLE Fact Guard v2.4 full Studio natural safe rewrite test passed");
