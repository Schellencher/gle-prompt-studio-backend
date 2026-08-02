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

function buildGroundingPromptBlock({ profile = null } = {}) {
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
      "- A selected Magic Context profile follows below. Its approved profile facts may be used as user-approved context, but they are not independently verified world truth.",
      "- Do not contradict approved profile facts. Do not infer additional profile-specific facts beyond what the profile says.",
      "- Natural wording is allowed, but every factual product/company/project claim must be directly supported by approved profile facts.",
      "- Approved profile facts are a source pool, not a checklist. Use only the facts relevant to the requested format; do not force every approved fact into every output.",
      "- Do not add benefits, suitability, performance, quality adjectives, use cases, causal effects or implications unless they are explicitly approved facts.",
      "- Neutral headings, engagement questions and non-transactional CTAs are allowed only when they add no new product/company/project claim.",
      "- Do not add hashtags that imply unapproved benefits or use cases. A hashtag may only repeat an approved name or approved fact value.",
      "- Prefer concise natural wording over explanatory filler.",
      buildProfilePromptBlock(profile),
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
