"use strict";

const assert = require("node:assert/strict");
const {
  PROOF_SEAL_VERSION,
  createProofSeal,
} = require("../src/proof-seal");

const proof = {
  status: "PASSED",
  profileId: "profile_trailfold",
  profileVersion: 4,
  matchedFactIds: ["fact_port", "fact_battery"],
  factVersions: [
    { id: "fact_name", version: 1 },
    { id: "fact_port", version: 2 },
    { id: "fact_light", version: 1 },
    { id: "fact_battery", version: 3 },
  ],
};

const first = createProofSeal({
  output: "TrailFold 12 hat USB-C und bis zu 12 Stunden Akkulaufzeit.",
  useCase: "LinkedIn Post",
  proof,
});

const second = createProofSeal({
  output: "TrailFold 12 hat USB-C und bis zu 12 Stunden Akkulaufzeit.",
  useCase: "LinkedIn Post",
  proof,
});

assert(first);
assert.equal(first.version, PROOF_SEAL_VERSION);
assert.equal(first.algorithm, "sha256");
assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
assert.equal(first.fingerprint, second.fingerprint);

const modified = createProofSeal({
  output: "TrailFold 12 hat USB-C und bis zu 12 Stunden Akkulaufzeit!",
  useCase: "LinkedIn Post",
  proof,
});

assert(modified);
assert.notEqual(first.fingerprint, modified.fingerprint);

const reordered = createProofSeal({
  output: "TrailFold 12 hat USB-C und bis zu 12 Stunden Akkulaufzeit.",
  useCase: "LinkedIn Post",
  proof: {
    ...proof,
    matchedFactIds: ["fact_battery", "fact_port"],
  },
});

assert(reordered);
assert.equal(first.fingerprint, reordered.fingerprint);

assert.deepEqual(first.matchedFacts, [
  { id: "fact_battery", version: 3 },
  { id: "fact_port", version: 2 },
]);

assert.equal(
  createProofSeal({
    output: "Ungeprüfter Text",
    useCase: "LinkedIn Post",
    proof: {
      ...proof,
      status: "BLOCKED",
      finalOutputVerified: false,
    },
  }),
  null,
);

assert.equal(
  createProofSeal({
    output: "Text ohne gematchte Fakten",
    useCase: "LinkedIn Post",
    proof: {
      ...proof,
      matchedFactIds: [],
    },
  }),
  null,
);

console.log("GLE ProofSeal test passed");
