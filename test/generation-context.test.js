"use strict";

const assert = require("assert");
const {
  ProfileError,
  createAccountProfile,
} = require("../src/profiles");
const {
  getRequestedProfileId,
  resolveGenerationProfile,
  buildGroundingPromptBlock,
} = require("../src/generation-context");

assert.equal(getRequestedProfileId({ profileId: " prf_123 " }), "prf_123");
assert.equal(getRequestedProfileId({ context_profile_id: "prf_alt" }), "prf_alt");
assert.equal(getRequestedProfileId({}), "");

const account = { accountId: "acc_test", profiles: [] };
const profile = createAccountProfile(
  account,
  {
    name: "Camping Brand",
    kind: "brand",
    brandName: "Nordlicht",
    audience: "Camping-Fans",
    voice: "Sachlich",
    context: "Nur belegte Produktmerkmale verwenden.",
    proofFacts: [
      {
        label: "Akkulaufzeit",
        value: "bis zu 12 Stunden",
        source: "Produktdatenblatt",
      },
      {
        label: "Anschluss",
        value: "USB-C",
        source: "Produktdatenblatt",
      },
    ],
  },
  { nowTs: 1000 },
);

assert.equal(resolveGenerationProfile(account, {}), null);
assert.equal(resolveGenerationProfile(account, { profileId: profile.id }).id, profile.id);

assert.throws(
  () => resolveGenerationProfile(account, { profileId: "prf_missing" }),
  (error) =>
    error instanceof ProfileError &&
    error.code === "profile_not_found" &&
    error.status === 404,
);

const noProfileBlock = buildGroundingPromptBlock();
assert(noProfileBlock.includes("GLE_GROUNDING_RULES_V2"));
assert(noProfileBlock.includes("Do not invent product features"));
assert(noProfileBlock.includes("employee results"));
assert(!noProfileBlock.includes("GLE_MAGIC_CONTEXT_PROFILE_V1"));

const profileBlock = buildGroundingPromptBlock({ profile });
assert(profileBlock.includes("GLE_MAGIC_CONTEXT_PROFILE_V1"));
assert(profileBlock.includes("Nordlicht"));
assert(profileBlock.includes("bis zu 12 Stunden"));
assert(profileBlock.includes("USB-C"));
assert(profileBlock.includes("not independently verified world truth"));
assert(profileBlock.includes("Natural wording is allowed"));
assert(profileBlock.includes("Do not add benefits, suitability, performance"));
assert(profileBlock.includes("source pool, not a checklist"));
assert(profileBlock.includes("Neutral headings, engagement questions"));
assert(profileBlock.includes("hashtag may only repeat an approved name or approved fact value"));



const socialProfileBlock = buildGroundingPromptBlock({
  profile,
  useCase: "Social Media Post",
  outLang: "DE",
});
assert(socialProfileBlock.includes("GLE_GROUNDED_DRAFT_RULES_V273"));
assert(socialProfileBlock.includes("GLE_SOCIAL_GROUNDED_DRAFT_V273"));
assert(socialProfileBlock.includes("CRITICAL PROOF BOUNDARY"));
assert(socialProfileBlock.includes("Audience, Voice and Context are editorial metadata"));
assert(socialProfileBlock.includes("Audience='Outdoor users'"));
assert(socialProfileBlock.includes("Gib exakt 7 nicht-leere Zeilen aus."));
assert(socialProfileBlock.includes("Zeilen 3-5: exakt drei Bullet-Zeilen"));
assert(socialProfileBlock.includes("Zeile 6: neutrale Interaktionsfrage"));
assert(socialProfileBlock.includes("weniger als drei unterschiedliche freigegebene Sachfakten"));
assert(socialProfileBlock.includes("Do not echo command words"));
assert(socialProfileBlock.includes("silently audit each factual sentence"));
assert(socialProfileBlock.includes("Bevorzuge eine dieser sicheren Frageformen"));
assert(socialProfileBlock.includes("Aktivitäten integrieren lässt"));
assert(socialProfileBlock.includes("Bevorzuge CTA-Formulierungen"));
assert(socialProfileBlock.includes("compact, lightweight, portable"));


const linkedInProfileBlock = buildGroundingPromptBlock({
  profile,
  useCase: "LinkedIn Post",
  outLang: "DE",
});
assert(linkedInProfileBlock.includes("GLE_GROUNDED_DRAFT_RULES_V273"));
assert(!linkedInProfileBlock.includes("GLE_SOCIAL_GROUNDED_DRAFT_V273"));

console.log("GLE generation context test passed");
