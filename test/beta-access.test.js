"use strict";

const assert = require("assert");
const { createBetaAccessControl } = require("../src/beta-access");

{
  const beta = createBetaAccessControl({ BETA_LOCK_ENABLED: "false" });
  assert.equal(beta.isAllowed({}), true, "disabled lock must allow requests");
}

{
  const beta = createBetaAccessControl({
    BETA_LOCK_ENABLED: "true",
    BETA_ALLOWED_EMAILS: "Tester@Example.com",
    BETA_ALLOWED_ACCOUNT_IDS: "acc_owner,acc_tester",
    BETA_ALLOWED_USER_IDS: "u_owner",
  });

  assert.equal(
    beta.isAllowed({ email: "tester@example.com" }),
    true,
    "email allowlist must be case-insensitive",
  );
  assert.equal(
    beta.isAllowed({ accountId: "acc_owner" }),
    true,
    "account allowlist must work",
  );
  assert.equal(
    beta.isAllowed({ userId: "u_owner" }),
    true,
    "user allowlist must work",
  );
  assert.equal(
    beta.isAllowed({ accountId: "acc_unknown", userId: "u_unknown" }),
    false,
    "unknown identity must be blocked",
  );

  assert.deepStrictEqual(beta.health(), {
    enabled: true,
    allowedEmailCount: 1,
    allowedAccountCount: 2,
    allowedUserCount: 1,
  });
}

console.log("GLE beta access test passed");
