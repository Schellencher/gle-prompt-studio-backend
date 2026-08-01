"use strict";

const assert = require("assert");
const {
  PROFILE_LIMIT,
  PROFILE_SCHEMA_VERSION,
  ProfileError,
  ensureAccountProfiles,
  createAccountProfile,
  updateAccountProfile,
  deleteAccountProfile,
  getAccountProfile,
  buildProfilePromptBlock,
} = require("../src/profiles");

const account = { accountId: "acc_test" };
assert.deepStrictEqual(ensureAccountProfiles(account), []);

const first = createAccountProfile(
  account,
  {
    name: "GLE Brand",
    kind: "brand",
    brandName: "GetLaunchEdge",
    audience: "Freelancer und Selbstständige",
    voice: "Direkt, klar, ohne Floskeln",
    context: "Geschlossene Beta. Keine Zukunftsversprechen als bereits verfügbar darstellen.",
    proofFacts: [
      { label: "Studio profile limit", value: "3", source: "Product rule" },
      { label: "Beta status", value: "Closed Beta", source: "Studio status" },
    ],
  },
  { nowTs: 1000 },
);

assert.equal(first.schemaVersion, PROFILE_SCHEMA_VERSION);
assert.equal(first.version, 1);
assert.equal(first.proofFacts.length, 2);
assert.ok(first.id.startsWith("prf_"));
assert.ok(first.proofFacts[0].id.startsWith("fact_"));
assert.equal(first.proofFacts[0].status, "approved");
assert.equal(getAccountProfile(account, first.id).brandName, "GetLaunchEdge");

const firstFactId = first.proofFacts[0].id;
const updated = updateAccountProfile(
  account,
  first.id,
  {
    voice: "Klar, präzise, menschlich",
    proofFacts: [
      {
        id: firstFactId,
        label: "Studio profile limit",
        value: "3",
        source: "Product rule",
      },
    ],
  },
  { nowTs: 2000 },
);

assert.equal(updated.name, "GLE Brand", "patch update must preserve omitted fields");
assert.equal(updated.voice, "Klar, präzise, menschlich");
assert.equal(updated.version, 2);
assert.equal(updated.proofFacts.length, 1);
assert.equal(updated.proofFacts[0].id, firstFactId, "existing fact id must stay stable");
assert.equal(updated.proofFacts[0].version, 1, "unchanged fact content must keep fact version");

const updatedFact = updateAccountProfile(
  account,
  first.id,
  {
    proofFacts: [
      {
        id: firstFactId,
        label: "Studio profile limit",
        value: "Maximum 3 saved profiles",
        source: "Product rule",
      },
    ],
  },
  { nowTs: 3000 },
);
assert.equal(updatedFact.proofFacts[0].version, 2, "changed fact must increment fact version");

const promptBlock = buildProfilePromptBlock(updatedFact);
assert(promptBlock.includes("GLE_MAGIC_CONTEXT_PROFILE_V1"));
assert(promptBlock.includes("GetLaunchEdge"));
assert(promptBlock.includes("Maximum 3 saved profiles"));
assert(promptBlock.includes(firstFactId));
assert(promptBlock.includes("not independently verified world truth"));

createAccountProfile(account, { name: "Client A" }, { nowTs: 4000 });
createAccountProfile(account, { name: "Client B" }, { nowTs: 5000 });
assert.equal(account.profiles.length, PROFILE_LIMIT);

assert.throws(
  () => createAccountProfile(account, { name: "Too many" }, { nowTs: 6000 }),
  (error) => error instanceof ProfileError && error.code === "profile_limit_reached" && error.status === 409,
  "fourth profile must be rejected",
);

const deleted = deleteAccountProfile(account, first.id);
assert.equal(deleted.id, first.id);
assert.equal(account.profiles.length, PROFILE_LIMIT - 1);
assert.equal(getAccountProfile(account, first.id), null);

assert.throws(
  () => createAccountProfile({ accountId: "x" }, { name: "" }),
  (error) => error instanceof ProfileError && error.code === "profile_validation_failed",
  "empty profile name must fail validation",
);

console.log("GLE profiles test passed");
