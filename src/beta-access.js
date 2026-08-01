"use strict";

function parseCsvSet(value, normalizer = (v) => String(v || "").trim()) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => normalizer(item))
      .filter(Boolean),
  );
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeId(value) {
  return String(value || "").trim();
}

function createBetaAccessControl(env = process.env) {
  const enabled =
    String(env.BETA_LOCK_ENABLED || "false").toLowerCase() === "true";

  const allowedEmails = parseCsvSet(env.BETA_ALLOWED_EMAILS, normalizeEmail);
  const allowedAccountIds = parseCsvSet(
    env.BETA_ALLOWED_ACCOUNT_IDS,
    normalizeId,
  );
  const allowedUserIds = parseCsvSet(env.BETA_ALLOWED_USER_IDS, normalizeId);

  function isAllowed({ email = "", accountId = "", userId = "" } = {}) {
    if (!enabled) return true;

    const normalizedEmail = normalizeEmail(email);
    const normalizedAccountId = normalizeId(accountId);
    const normalizedUserId = normalizeId(userId);

    if (normalizedEmail && allowedEmails.has(normalizedEmail)) return true;
    if (normalizedAccountId && allowedAccountIds.has(normalizedAccountId)) {
      return true;
    }
    if (normalizedUserId && allowedUserIds.has(normalizedUserId)) return true;

    return false;
  }

  function health() {
    return {
      enabled,
      allowedEmailCount: allowedEmails.size,
      allowedAccountCount: allowedAccountIds.size,
      allowedUserCount: allowedUserIds.size,
    };
  }

  return {
    enabled,
    isAllowed,
    health,
    normalizeEmail,
  };
}

module.exports = {
  createBetaAccessControl,
  normalizeEmail,
  normalizeId,
  parseCsvSet,
};
