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
assert(noProfileBlock.includes("GLE_GROUNDING_RULES_V1"));
assert(noProfileBlock.includes("Do not invent product features"));
assert(noProfileBlock.includes("employee results"));
assert(!noProfileBlock.includes("GLE_MAGIC_CONTEXT_PROFILE_V1"));

const profileBlock = buildGroundingPromptBlock({ profile });
assert(profileBlock.includes("GLE_MAGIC_CONTEXT_PROFILE_V1"));
assert(profileBlock.includes("Nordlicht"));
assert(profileBlock.includes("bis zu 12 Stunden"));
assert(profileBlock.includes("USB-C"));
assert(profileBlock.includes("not independently verified world truth"));

console.log("GLE generation context test passed");
