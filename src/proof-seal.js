"use strict";

const crypto = require("crypto");

const PROOF_SEAL_VERSION = "proof-seal-v1";

function isFinalOutputVerified(proof) {
  const status = String(proof?.status || "").toUpperCase();

  return (
    status === "PASSED" ||
    proof?.finalOutputVerified === true
  );
}

function buildMatchedFactVersions(proof) {
  const matchedIds = Array.isArray(proof?.matchedFactIds)
    ? [...new Set(proof.matchedFactIds.map(String))]
    : [];

  const versions = Array.isArray(proof?.factVersions)
    ? proof.factVersions
    : [];

  return matchedIds
    .map((id) => {
      const match = versions.find(
        (entry) => String(entry?.id || "") === id,
      );

      return {
        id,
        version: Number(match?.version || 1),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function createProofSeal({ output, useCase, proof }) {
  if (!isFinalOutputVerified(proof)) {
    return null;
  }

  const matchedFacts = buildMatchedFactVersions(proof);

  if (!matchedFacts.length) {
    return null;
  }

  const payload = {
    sealVersion: PROOF_SEAL_VERSION,
    output: String(output ?? ""),
    useCase: String(useCase || "").trim(),
    profileId: String(proof?.profileId || ""),
    profileVersion: Number(proof?.profileVersion || 1),
    proofStatus: String(proof?.status || "").toUpperCase(),
    matchedFacts,
  };

  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");

  return {
    version: PROOF_SEAL_VERSION,
    algorithm: "sha256",
    fingerprint,
    profileId: payload.profileId,
    profileVersion: payload.profileVersion,
    matchedFacts,
  };
}

module.exports = {
  PROOF_SEAL_VERSION,
  createProofSeal,
};
