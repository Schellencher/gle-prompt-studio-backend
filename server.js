"use strict";

/**
 * GLE Prompt Studio Backend â€” CLEAN FINAL (v2.2)
 *
 * Features:
 * - BYOK + PRO(Server-Key) + optional BYOK_ONLY
 * - Trial optional (rolling 24h) via TRIAL_ENABLED (default OFF)
 * - Quota: FREE/PRO monthly limits + Boost limit for PRO
 * - Stripe Checkout (Subscription) + Sync via session_id + Billing Portal
 * - Stripe Webhook handling (checkout.session.completed, customer.subscription.*)
 * - JSON file DB (Render persistent disk friendly via DATA_DIR)
 * - CORS allowlist (studio.getlaunchedge.com + scoped Vercel previews + ENV override)
 * - OpenAI call: Responses API + fallback Chat Completions
 * - Server-side Bouncer: banned stems scan + rewrite passes + hard fail 422
 * - CTA normalizer + neutral CTA enforcement + hot-stem sanitizer (NON-social only)
 * - Social Media Post: strict 7-line validator + deterministic fallback
 * - Admin endpoint: set plan PRO/FREE via ADMIN_KEY
 */

"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const {
  createGateway,
  createRequestId,
  GLEGatewayError,
  toPublicError,
} = require("./src/gateway");
const { createBetaAccessControl } = require("./src/beta-access");
const {
  PROFILE_LIMIT,
  PROFILE_SCHEMA_VERSION,
  MAX_PROOF_FACTS,
  ProfileError,
  ensureAccountProfiles,
  listAccountProfiles,
  getAccountProfile,
  createAccountProfile,
  updateAccountProfile,
  deleteAccountProfile,
} = require("./src/profiles");
const {
  resolveGenerationProfile,
  buildGroundingPromptBlock,
} = require("./src/generation-context");
const {
  buildLandingpageJsonPrompt: buildLandingpageJsonPromptV2,
  buildLandingpageJsonRepairPrompt,
  renderLandingpageOutput: renderLandingpageOutputV2,
} = require("./src/landingpage-structured");

const betaAccess = createBetaAccessControl(process.env);

function betaAccessDeniedResponse(req, res) {
  const lang = String(
    req.body?.language || req.body?.lang || "de",
  ).toLowerCase();

  const message =
    lang === "en"
      ? "Access to GLE Prompt Studio is currently limited to invited beta testers."
      : "Der Zugang zu GLE Prompt Studio ist aktuell auf eingeladene Beta-Tester beschränkt.";

  return res.status(403).json({
    error: "beta_access_required",
    message,
  });
}

// ---- fetch (Node 18+ has global fetch). Fallback to node-fetch@2 if needed.
let _fetch = globalThis.fetch;
if (!_fetch) {
  try {
    _fetch = require("node-fetch"); // node-fetch@2
  } catch {
    throw new Error(
      "No fetch available. Use Node 18+ or install node-fetch@2.",
    );
  }
}

// --------------------
// Config
// --------------------
const PORT = Number(process.env.PORT || 3002);

const DATA_DIR =
  String(process.env.DATA_DIR || "").trim() || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "gle-db.json");

const BYOK_ONLY = String(process.env.BYOK_ONLY || "0") === "1";

// --------------------
// OpenAI / Models
// --------------------
const OPENAI_API_BASE =
  String(process.env.OPENAI_API_BASE || "").trim() ||
  "https://api.openai.com/v1";

const SERVER_OPENAI_KEY =
  String(process.env.OPENAI_API_KEY_SERVER || "").trim() ||
  String(process.env.OPENAI_API_KEY || "").trim();

const SERVER_DEEPSEEK_KEY = String(process.env.DEEPSEEK_API_KEY || "").trim();
const SERVER_AI_CONFIGURED = Boolean(SERVER_OPENAI_KEY || SERVER_DEEPSEEK_KEY);

// Internal model IDs (never shown to users)
const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o").trim();
const MODEL_BOOST = String(process.env.MODEL_BOOST || "gpt-4o").trim();

// Public engine labels (shown in UI)
const ENGINE_BYOK = String(
  process.env.ENGINE_BYOK || "GLE Core v2.4 (BYOK)",
).trim();
const ENGINE_PRO = String(
  process.env.ENGINE_PRO || "GLE Core v2.4 (Active)",
).trim();
const ENGINE_TRIAL = String(
  process.env.ENGINE_TRIAL || "GLE Core v2.4 (Trial)",
).trim();
const ENGINE_ULTRA = String(
  process.env.ENGINE_ULTRA || "High-Density Engine (Ultra)",
).trim();


// GLE Multi-Engine Gateway aliases. Defaults preserve the current OpenAI behavior.
const GLE_PRO_ALIAS = String(process.env.GLE_PRO_ALIAS || "gle-balanced").trim();
const GLE_BOOST_ALIAS = String(
  process.env.GLE_BOOST_ALIAS || "gle-precision",
).trim();
const GLE_TRIAL_ALIAS = String(
  process.env.GLE_TRIAL_ALIAS || "gle-balanced",
).trim();

const aiGateway = createGateway({
  fetchImpl: _fetch,
  dataDir: DATA_DIR,
  env: process.env,
});

// --------------------
// Limits / Trial
// --------------------
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);
const PRO_BOOST_LIMIT = Number(process.env.PRO_BOOST_LIMIT || 50);

const TRIAL_ENABLED = String(process.env.TRIAL_ENABLED || "0") === "1";
const TRIAL_LIMIT_24H = Number(process.env.TRIAL_LIMIT_24H || 3);

// Maintenance (blocks billing routes)
const MAINTENANCE_MODE =
  String(process.env.MAINTENANCE_MODE || "").trim() === "1";

// Admin
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();

// --------------------
// Stripe
// --------------------
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PRICE_ID = String(process.env.STRIPE_PRICE_ID || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || "",
).trim();

const FRONTEND_URL = (
  String(process.env.FRONTEND_URL || "").trim() ||
  "https://studio.getlaunchedge.com"
).replace(/\/$/, "");

const STRIPE_RETURN_URL = String(
  process.env.STRIPE_RETURN_URL ||
    process.env.STRIPE_BILLING_RETURN_URL ||
    FRONTEND_URL,
)
  .trim()
  .replace(/\/$/, "");

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-12-15.clover" })
  : null;

function stripeModeLabel() {
  if (!stripe) return "DISABLED";
  return STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "TEST";
}

function denyBilling(res) {
  res.set("Retry-After", "3600");
  return res.status(503).json({
    ok: false,
    error: "maintenance",
    message: "Billing disabled during maintenance.",
  });
}

// --------------------
// CORS
// --------------------
const defaultOrigins = Array.from(
  new Set(
    [
      "https://studio.getlaunchedge.com",
      "https://gle-prompt-studio.vercel.app",
      FRONTEND_URL,
    ].filter(Boolean),
  ),
);

const extraOriginsRaw = String(
  process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "",
).trim();

const extraOrigins = extraOriginsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const VERCEL_PROJECT_SLUG = String(
  process.env.VERCEL_PROJECT_SLUG || "gle-prompt-studio",
)
  .trim()
  .toLowerCase();

const ALLOWED_ORIGINS = Array.from(
  new Set([...defaultOrigins, ...extraOrigins]),
);

function isAllowedVercelPreview(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;

    const host = u.hostname.toLowerCase();
    if (!host.endsWith(".vercel.app")) return false;

    return (
      host === `${VERCEL_PROJECT_SLUG}.vercel.app` ||
      host.startsWith(`${VERCEL_PROJECT_SLUG}-`)
    );
  } catch {
    return false;
  }
}

function allowedOrigin(origin) {
  if (!origin) return true; // curl / server-to-server
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return isAllowedVercelPreview(origin);
}

function pickReturnBase(req) {
  const origin = String(req.headers.origin || "").trim();
  if (origin && allowedOrigin(origin)) return origin.replace(/\/$/, "");
  return STRIPE_RETURN_URL;
}

// --------------------
// Simple JSON DB
// --------------------
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function now() {
  return Date.now();
}

function monthKeyFromTs(ts = now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function firstDayNextMonthTs(ts = now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth();
  return new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();
}

const db = { accounts: {}, customers: {} }; // customers: stripeCustomerId -> accountId
let _saveTimer = null;

function loadDb() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") {
      db.accounts = parsed.accounts || {};
      db.customers = parsed.customers || {};
    }
  } catch (e) {
    console.error("DB load error:", e);
  }
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      ensureDir(DATA_DIR);
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error("DB save error:", e);
    }
  }, 250);
}

function syncStripeMode(account) {
  if (!account) return;

  if (!account.stripe) {
    account.stripe = {
      mode: stripeModeLabel(),
      customerId: "",
      subscriptionId: "",
      status: "",
      currentPeriodEnd: 0,
      cancelAt: 0,
      cancelAtPeriodEnd: false,
    };
    scheduleSave();
    return;
  }

  const currentMode = stripeModeLabel();
  if (account.stripe.mode !== currentMode) {
    account.stripe.mode = currentMode;
    scheduleSave();
  }
}

function getOrCreateAccount(accountId, userId) {
  const id = String(accountId || "").trim();
  const uid = String(userId || "").trim() || "anon";
  if (!id) throw new Error("missing_account_id");

  if (!db.accounts[id]) {
    db.accounts[id] = {
      accountId: id,
      userId: uid,
      createdAt: now(),
      plan: "FREE", // FREE | PRO
      stripe: {
        mode: stripeModeLabel(),
        customerId: "",
        subscriptionId: "",
        status: "",
        currentPeriodEnd: 0,
        cancelAt: 0,
        cancelAtPeriodEnd: false,
      },
      usage: { monthKey: monthKeyFromTs(), used: 0, boostUsed: 0, lastTs: 0 },
      trial: { events: [] },
      apiKeyEnc: "",
      profiles: [],
    };
    scheduleSave();
  } else if (uid && db.accounts[id].userId !== uid) {
    db.accounts[id].userId = uid;
    scheduleSave();
  }

  syncStripeMode(db.accounts[id]);
  if (!Array.isArray(db.accounts[id].profiles)) {
    ensureAccountProfiles(db.accounts[id]);
    scheduleSave();
  }
  return db.accounts[id];
}

function getAccountByCustomer(customerId) {
  const cid = String(customerId || "").trim();
  const accId = db.customers[cid];
  if (!accId) return null;

  const acc = db.accounts[accId] || null;
  if (acc) syncStripeMode(acc);
  return acc;
}

function attachCustomerToAccount(account, customerId) {
  const cid = String(customerId || "").trim();
  if (!cid) return;
  account.stripe.customerId = cid;
  db.customers[cid] = account.accountId;
  scheduleSave();
}

// --------------------
// Request helpers
// --------------------
function getIds(req) {
  const h = req.headers || {};

  const accountId = String(
    h["x-gle-account-id"] || h["x-gle-accountid"] || h["x-account-id"] || "",
  ).trim();

  const userId = String(
    h["x-gle-user-id"] ||
      h["x-gle-user"] || // fallback fÃ¼r Frontend-Bug
      h["x-user-id"] ||
      "",
  ).trim();

  return { accountId, userId };
}

function getApiKey(req) {
  return String(
    req.headers["x-gle-api-key"] ||
      req.headers["x-openai-key"] ||
      req.headers["x-api-key"] ||
      req.body?.apiKey ||
      "",
  ).trim();
}

function resolveBetaAccount(req, res) {
  const { userId, accountId } = getIds(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "missing_account_id" });
    return null;
  }

  const acc = getOrCreateAccount(accountId, userId);
  const betaEmail = betaAccess.normalizeEmail(
    acc?.email ||
      acc?.userEmail ||
      acc?.accountEmail ||
      req.user?.email ||
      "",
  );

  if (
    !betaAccess.isAllowed({
      email: betaEmail,
      accountId,
      userId,
    })
  ) {
    betaAccessDeniedResponse(req, res);
    return null;
  }

  return { acc, accountId, userId };
}

function sendProfileError(res, error) {
  if (error instanceof ProfileError) {
    return res.status(Number(error.status || 400)).json({
      ok: false,
      error: error.code || "profile_failed",
      message: error.message || "Profile request failed",
      details: error.details || undefined,
    });
  }

  console.error("profile error:", error);
  return res.status(500).json({
    ok: false,
    error: "profile_failed",
    message: String(error?.message || error || "Profile request failed"),
  });
}

function normalizeStripeTs(sec) {
  const n = Number(sec || 0);
  return n > 0 ? n * 1000 : 0;
}

// --------------------
// Usage + limits
// --------------------
function ensureMonthlyBucket(account) {
  const mk = monthKeyFromTs();
  if (account.usage.monthKey !== mk) {
    account.usage.monthKey = mk;
    account.usage.used = 0;
    account.usage.boostUsed = 0;
    account.usage.lastTs = 0;
    scheduleSave();
  }
}

function planIsPro(account) {
  return String(account.plan || "FREE").toUpperCase() === "PRO";
}

function computeRenewAt(account) {
  const cpe = Number(account?.stripe?.currentPeriodEnd || 0);
  if (cpe > 0) return cpe;
  return firstDayNextMonthTs();
}

function computeCancelAt(account) {
  const c = Number(account?.stripe?.cancelAt || 0);
  return c > 0 ? c : 0;
}

function enforceQuota(account, wantsBoost, shouldCountUsage = true) {
  ensureMonthlyBucket(account);
  const isPro = planIsPro(account);
  const used = Number(account.usage.used || 0);
  const limit = isPro ? PRO_LIMIT : FREE_LIMIT;

  if (shouldCountUsage && used >= limit) {
    return {
      ok: false,
      error: "quota_reached",
      used,
      limit,
      renewAt: computeRenewAt(account),
    };
  }

  if (wantsBoost) {
    if (!isPro) return { ok: false, error: "boost_requires_pro" };
    const bUsed = Number(account.usage.boostUsed || 0);
    if (bUsed >= PRO_BOOST_LIMIT) {
      return {
        ok: false,
        error: "boost_quota_reached",
        boostUsed: bUsed,
        boostLimit: PRO_BOOST_LIMIT,
        renewAt: computeRenewAt(account),
      };
    }
  }

  return { ok: true };
}

function markUsage(account, wantsBoost, shouldCountUsage = true) {
  ensureMonthlyBucket(account);

  if (shouldCountUsage) {
    account.usage.used = Number(account.usage.used || 0) + 1;
    account.usage.lastTs = now();
  }

  if (wantsBoost) {
    account.usage.boostUsed = Number(account.usage.boostUsed || 0) + 1;
  }

  scheduleSave();
}

// Trial: rolling 24h window (optional)
function trialAllowed(account) {
  if (!TRIAL_ENABLED) return { ok: false, reason: "trial_disabled" };
  if (BYOK_ONLY) return { ok: false, reason: "byok_only" };
  if (!SERVER_OPENAI_KEY) return { ok: false, reason: "missing_server_key" };
  if (planIsPro(account)) return { ok: false, reason: "already_pro" };

  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = now() - windowMs;

  const events = Array.isArray(account.trial?.events)
    ? account.trial.events
    : [];
  const fresh = events.filter((ts) => Number(ts) > cutoff);
  account.trial.events = fresh;

  if (fresh.length >= TRIAL_LIMIT_24H) {
    scheduleSave();
    return {
      ok: false,
      reason: "trial_limit_reached",
      used: fresh.length,
      limit: TRIAL_LIMIT_24H,
    };
  }
  return { ok: true, used: fresh.length, limit: TRIAL_LIMIT_24H };
}

function markTrial(account) {
  if (!account.trial) account.trial = { events: [] };
  if (!Array.isArray(account.trial.events)) account.trial.events = [];
  account.trial.events.unshift(now());
  account.trial.events = account.trial.events.slice(0, 50);
  scheduleSave();
}

// ===============================
// BOUNCER v2 â€” server-side quality gate
// ===============================
const BOUNCER_ENABLED = String(process.env.BOUNCER_ENABLED || "0") === "1";
const BOUNCER_MAX_PASSES = Math.max(
  0,
  Number(process.env.BOUNCER_MAX_PASSES || 0),
);

const REQUIRED_BANNED_STEMS = [
  "tutmirleid",
  "bittegib",
  "benoetig",
  "mehrinformation",
  "ichkann",
  "imsorry",
  "cantcomply",
  "cannotcomply",
];

const DEFAULT_BANNED_STEMS = [
  "optimier",
  "steiger",
  "verbesser",
  "erleb",
  "profit",
  "verpass",
  "chance",
  "exklus",
  "konkurrenz",
  "agentur",
  "erfolg",
  "nutz",
  "vorteil",
  "vorsp",
  "sicher",
  "leader",
  "luxus",
  "strateg",
];

function _normalizeForScan(input) {
  let s = String(input || "").toLowerCase();
  s = s
    .replace(/Ã¤/g, "ae")
    .replace(/Ã¶/g, "oe")
    .replace(/Ã¼/g, "ue")
    .replace(/ÃŸ/g, "ss");
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return s;
}

function _splitEnvStems(envVal) {
  const raw = String(envVal || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function _dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const key = String(x || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function getActiveBannedStems() {
  const fromEnv = _splitEnvStems(process.env.BOUNCER_BANNED_STEMS);
  const base = fromEnv.length ? fromEnv : DEFAULT_BANNED_STEMS;
  const combined = _dedupeKeepOrder([...base, ...REQUIRED_BANNED_STEMS]);
  return _dedupeKeepOrder(
    combined
      .map((stem) => _normalizeForScan(stem).replace(/\s+/g, ""))
      .filter(Boolean),
  );
}

const ACTIVE_BANNED_STEMS = getActiveBannedStems();

function findStemViolations(text, stems = ACTIVE_BANNED_STEMS) {
  const hay = _normalizeForScan(text);
  if (!hay) return [];
  const hayCompact = hay.replace(/\s+/g, "");
  const hits = [];
  for (const stemRaw of stems) {
    const stem = _normalizeForScan(stemRaw).replace(/\s+/g, "");
    if (!stem) continue;
    if (hayCompact.includes(stem)) hits.push(stem);
  }
  return _dedupeKeepOrder(hits);
}

// --------------------
// CTA + Sanitizer (last mile) â€” NON-social only
// --------------------
function detectCtaLabelFromExtra(extra) {
  const s = String(extra || "");
  if (/CTA-Zeile/i.test(s)) return "CTA-Zeile";
  if (/CTA\s*:/i.test(s)) return "CTA";
  return null;
}

function normalizeCtaLabel(output, extra) {
  const want = detectCtaLabelFromExtra(extra);
  if (!want) return String(output || "");

  return String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:\d+\)\s*)?)(CTA(?:-Zeile)?\s*:)(.*)$/i);
      if (!m) return line;
      return `${m[1]}${want}:${m[3] || ""}`;
    })
    .join("\n");
}

function forceNeutralCTA(output, extra) {
  const allowed = [
    "Zur Warteliste.",
    "Early Access: Eintragen.",
    "Warteliste Ã¶ffnen.",
  ];
  const chosen = allowed[0];

  const want = detectCtaLabelFromExtra(extra);
  const out = String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:\d+\)\s*)?)(CTA(?:-Zeile)?\s*:)\s*(.*)$/i);
      if (!m) return line;
      const label = want ? `${want}:` : m[2];
      return `${m[1]}${label} ${chosen}`;
    })
    .join("\n");

  const expects =
    /CTA-Zeile/i.test(String(extra || "")) ||
    /CTA\s*:/i.test(String(extra || ""));
  const hasCta = /(^|\n)\s*(\d+\)\s*)?CTA(?:-Zeile)?\s*:/i.test(out);
  if (expects && !hasCta) {
    const label = want ? `${want}:` : "CTA:";
    return `${out}\n\n${label} ${chosen}`;
  }
  return out;
}

function hardStripHotStems(output) {
  let s = String(output || "");

  const repl = [
    [/\b(nutz\w*)\b/gi, "verwenden"],
    [/\b(vorsprung\w*)\b/gi, "klarer Schritt nach vorn"],
    [/\b(vorsp\w*)\b/gi, "klarer Schritt nach vorn"],
    [/\b(sicher\w*)\b/gi, "jetzt"],
    [/\b(optimier\w*|steiger\w*|verbesser\w*)\b/gi, "reduzieren"],
    [/\b(erfolg\w*)\b/gi, "Ergebnis"],
    [
      /\b(chanc\w*|verpass\w*|profit\w*|exklus\w*|konkurrenz\w*|agentur\w*|leader\w*|luxus\w*|strateg\w*)\b/gi,
      "",
    ],
    [/\b(hochwertig\w*|blitzschnell\w*|revolution\w*|premium\w*)\b/gi, ""],
  ];

  for (const [rx, to] of repl) s = s.replace(rx, to);

  s = s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

// --------------------
// OpenAI call (Responses API + fallback)
// --------------------
async function openaiResponses({ apiKey, model, input, temperature }) {
  const url = `${OPENAI_API_BASE.replace(/\/$/, "")}/responses`;
  const res = await _fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      temperature: safeTemperature(model, temperature, undefined),
    }),
  });

  function safeTemperature(model, temperature, fallback) {
    const m = String(model || "").toLowerCase();
    if (m.startsWith("gpt-5")) return undefined;
    if (typeof temperature === "number") return temperature;
    return fallback;
  }

  const text = await res.text().catch(() => "");
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _text: text };
  }

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      data?._text ||
      `openai_error_${res.status}`;
    throw new Error(String(msg));
  }

  if (typeof data.output_text === "string" && data.output_text.trim())
    return data.output_text.trim();

  const out = Array.isArray(data.output) ? data.output : [];
  for (const item of out) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        const s = c.text.trim();
        if (s) return s;
      }
    }
  }
  throw new Error("No text from OpenAI");
}

async function openaiChatCompletions({ apiKey, model, prompt, temperature }) {
  const url = `${OPENAI_API_BASE.replace(/\/$/, "")}/chat/completions`;
  const res = await _fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            'Du bist "GLE Prompt Studio". Folge den Regeln im User-Prompt strikt und gib nur den fertigen Output aus.',
        },
        { role: "user", content: String(prompt || "") },
      ],
      temperature: safeTemperature(model, temperature, 0.6),
    }),
  });

  const text = await res.text().catch(() => "");
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _text: text };
  }

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      data?._text ||
      `openai_error_${res.status}`;
    throw new Error(String(msg));
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("No text from OpenAI");
}

async function callOpenAI({ apiKey, model, prompt, temperature }) {
  try {
    return await openaiResponses({ apiKey, model, input: prompt, temperature });
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
      return await openaiChatCompletions({
        apiKey,
        model,
        prompt,
        temperature,
      });
    }
    throw e;
  }
}

// --------------------
// Input mapping
// --------------------
function normalizeInputs(body) {
  const b = body || {};

  const useCase = String(
    b.useCase ?? b.use_case ?? b.uc ?? b.template ?? b.type ?? "",
  ).trim();
  const tone = String(b.tone ?? b.style ?? b.voice ?? "").trim();

  // accept topic/extra/outLang AND goal/context/language
  const topic = String(b.topic ?? b.goal ?? b.subject ?? b.title ?? "").trim();
  const extra = String(
    b.extra ?? b.context ?? b.instructions ?? b.prompt ?? "",
  ).trim();

  const outLangRaw = String(b.outLang ?? b.language ?? b.lang ?? "DE").trim();
  const outLang = outLangRaw.toLowerCase() === "en" ? "en" : "de";

  const boost = b.boost === true;

  return { useCase, tone, topic, extra, outLang, boost };
}

// --------------------
// Master Prompt Builder (required)
// --------------------
function buildMasterPrompt({ useCase, tone, topic, extra, outLang }) {
  const lang = String(outLang || "de").toLowerCase() === "en" ? "EN" : "DE";
  const uc = String(useCase || "").trim() || "Content";
  const t =
    String(tone || "").trim() ||
    (lang === "EN" ? "Professional" : "Professionell");
  const cleanTopic = String(topic || "").trim();
  const cleanExtra = String(extra || "").trim();

  return `
Du bist "GLE Prompt Studio".
Du lieferst FERTIGEN Content. Kein Meta, keine RÃ¼ckfragen, keine Entschuldigungen.

Zielsprache: ${lang}
Use-Case: ${uc}
Ton: ${t}

HARTE REGELN:
- Keine EinleitungssÃ¤tze ("Hier ist...", "Gerne...", "Es tut mir leid...").
- Keine Emojis.
- Keine Buzzwords/Floskeln wie "hochwertig", "ohne Aufwand", "Premium", "revolutionÃ¤r".
- Keine leeren Ãœberschriften, keine leeren Nummernpunkte, keine leeren Bulletpoints.
- Jede nummerierte Zeile muss Inhalt haben.
- Wenn ein Format Punkt 1), 2), 3) usw. verlangt, muss jeder Punkt vollstÃ¤ndig ausgefÃ¼llt sein.
- CTA nur einmal ausgeben.
- Wenn im Format bereits "CTA-Zeile" verlangt wird, dann KEINE zusÃ¤tzliche CTA am Ende anhÃ¤ngen.
- CTA neutral halten, z.B. "Mehr erfahren.", "Details ansehen.", "Kontakt aufnehmen."
- FAQ sauber schreiben: Frage und Antwort jeweils vollstÃ¤ndig, keine halben Zeilen.
- Schreibe konkret: was + fÃ¼r wen + Ergebnis, in einfachen Worten.
- Ausgabe: nur der finale Content.

QUALITÃ„TSREGELN:
- Kein Platzhaltertext.
- Keine technischen Begriffe wie BYOK, Server-Key, Tokens, Modellname, GPT, API.
- Keine SÃ¤tze Ã¼ber KI oder das Tool selbst, auÃŸer das Thema verlangt es ausdrÃ¼cklich.
- Kein "Link in Bio".
- Kein doppelter CTA.
- Wenn der Nutzer ein exaktes Format vorgibt, halte dieses Format ein und fÃ¼lle jeden Punkt vollstÃ¤ndig.
- Erfinde keine Marken, Produktnamen, Zielgruppen, Preise, Verfuegbarkeiten, Studien, Quellen oder Leistungsversprechen, die nicht in THEMA oder FORMAT / Anforderungen stehen.

THEMA:
${cleanTopic || "(kein Thema angegeben)"}

FORMAT / Anforderungen (exakt einhalten und vollstÃ¤ndig ausfÃ¼llen):
${cleanExtra || "(kein Format vorgegeben)"}
`.trim();
}

// --------------------
// Repair Prompt (single source of truth)
// --------------------
function buildRepairPrompt({
  badOutput,
  hits,
  useCase,
  tone,
  topic,
  extra,
  outLang,
}) {
  const lang = String(outLang || "de").toLowerCase() === "en" ? "EN" : "DE";
  const bannedAll =
    Array.isArray(ACTIVE_BANNED_STEMS) && ACTIVE_BANNED_STEMS.length
      ? ACTIVE_BANNED_STEMS.join(", ")
      : "";
  const hitList = Array.isArray(hits) && hits.length ? hits.join(", ") : "";

  // Social Media Post = strict 7 lines
  if (String(useCase || "").trim() === "Social Media Post") {
    return `
You are a strict formatter AND copy editor.

Rewrite the text below completely new if needed.
Remove banned word stems.
Keep meaning.
DO NOT reuse phrases directly.

LANGUAGE: ${lang}
TONE: ${tone}

BANNED STEMS (must NOT appear):
${bannedAll || "(none)"}

REQUIRED STRUCTURE (EXACTLY 7 LINES):
Line 1: Hook sentence (no title).
Line 2: Short main text sentence (exactly one sentence, no bullet).
Line 3: - Bullet point 1
Line 4: - Bullet point 2
Line 5: - Bullet point 3
Line 6: - Bullet point 4
Line 7: Specific CTA sentence with a clear action (comment/reply/click/write).

STRICT RULES:
- NO titles
- NO markdown
- NO bold (**)
- NO generic CTA
- DO NOT add lines
- DO NOT merge lines
- Output ONLY the 7 lines
- If impossible: output FORMAT_ERROR

Previous output (do NOT reuse directly):
"""
${String(badOutput || "").slice(0, 2000)}
"""
`.trim();
  }

  // Default repair for other use-cases
  return `
Du bist strenger Copy-Editor. Du lieferst FERTIGEN Content â€“ kein Meta, keine Entschuldigungen.
Zielsprache: ${lang}
Use-Case: ${useCase}
Ton: ${tone}
Thema: ${topic}

QUALITY GATE (hart):
1) Schreibe KOMPLETT NEU. Nicht umformulieren, nichts wiederverwenden.
2) Keine EinleitungssÃ¤tze, keine ErklÃ¤rungen, kein â€œHier istâ€¦â€.
3) Keine Entschuldigungen / kein â€œmir fehlen Infosâ€.
4) Keine Floskeln & kein Marketing-Pathos. Kurz, klar, konkret.
5) Keine Sie-Ansprache. Nutze â€œduâ€ ODER neutral ohne Pronomen.
6) VERBOTEN: In deiner finalen Antwort darf KEIN Wortteil aus dieser Liste vorkommen:
${bannedAll || "(leer)"}
7) Treffer im letzten Output waren: ${hitList || "(keine)"} â€” diese mÃ¼ssen weg.
8) CTA neutral halten. Kein Imperativ.
9) Wenn ein verbotener Stamm vorkommt: komplett neu schreiben. Nicht erwÃ¤hnen.

FORMAT / Anforderungen (exakt einhalten):
${extra}

Alter Output (nur zur Analyse, NICHT wiederverwenden):
"""
${String(badOutput || "").slice(0, 2000)}
"""
`.trim();
}

// --------------------
// Social Post: Format Validation Helpers
// --------------------
function stripMarkdownArtifacts(s = "") {
  let out = String(s || "");
  out = out.replace(/\*\*/g, "");
  out = out.replace(/^\s*#+\s+.*$/gm, "");
  out = out.replace(/\r\n/g, "\n").trim();
  return out;
}

function repairEncodingArtifacts(value) {
  if (!value || typeof value !== "string") return value;

  return value
    .replace(/\u00C3\u00BC/g, "\u00FC")
    .replace(/\u00C3\u00A4/g, "\u00E4")
    .replace(/\u00C3\u00B6/g, "\u00F6")
    .replace(/\u00C3\u009C/g, "\u00DC")
    .replace(/\u00C3\u0084/g, "\u00C4")
    .replace(/\u00C3\u0096/g, "\u00D6")
    .replace(/\u00C3\u009F/g, "\u00DF")
    .replace(/\u00E2\u201A\u00AC/g, "\u20AC")
    .replace(/\u00E2\u20AC\u201C/g, "-")
    .replace(/\u00E2\u20AC\u201D/g, "-")
    .replace(/\u00C2\u00B7/g, "-")
    .replace(/\u00C2/g, "");
}

function sanitizeLandingPageOutput(output, { outLang = "DE" } = {}) {
  if (!output || typeof output !== "string") return output;

  const isEn = String(outLang).toLowerCase().startsWith("en");

  output = output
    .replace(/EntwÃ¼rfe/g, "Entwürfe")
    .replace(/fÃ¼r/g, "für")
    .replace(/unnÃ¶tige/g, "unnötige")
    .replace(/QualitÃ¤t/g, "Qualität")
    .replace(/spÃ¤ter/g, "später")
    .replace(/ermöglicht Strukturierte/g, "ermöglicht strukturierte")
    .replace(/Sofortige Zugriff/g, "Sofortiger Zugriff")
    .replace(/klar Inhalte/g, "klare Inhalte")
    .replace(/durchgehend klar Texte/g, "durchgehend klare Texte")
    .replace(
      /Tool für Erstellung von Content/g,
      "Tool für die Erstellung von Content",
    )
    .replace(
      /Reduziert Zeitverlust bei der Content-Erstellung erheblich\./g,
      "Reduziere den Zeitverlust bei der Content-Erstellung erheblich.",
    )
    .replace(
      /Eine benutzerfreundliche Oberfläche einfache Handhabung\./g,
      "Eine benutzerfreundliche Oberfläche erleichtert die Handhabung.",
    )
    .replace(
      /GLE Prompt Studio für Creator und Solopreneure\./g,
      "GLE Prompt Studio unterstützt Creator und Solopreneure bei der Content-Erstellung.",
    );

  const bannedBulletPattern = isEn
    ? /(waitlist|early access|sign up|join now|cta|price|19\.99|19,99|\$|eur|euro)/i
    : /(warteliste|early access|melde dich|anmelden|cta|preis|19\.99|19,99|€|eur|euro)/i;

  const safeBullets = isEn
    ? [
        "Save time when preparing recurring content.",
        "Create structured drafts for social posts, ads and landing pages.",
        "Keep content quality consistent across multiple outputs.",
        "Use repeatable formats instead of starting from scratch every time.",
        "Turn rough ideas into clear content structures faster.",
      ]
    : [
        "Spare Zeit bei der Vorbereitung wiederkehrender Inhalte.",
        "Erstelle strukturierte Entwürfe für Social Posts, Ads und Landingpages.",
        "Halte die Content-Qualität über mehrere Ausgaben hinweg konsistent.",
        "Nutze wiederholbare Formate statt jedes Mal bei null zu starten.",
        "Verwandle grobe Ideen schneller in klare Content-Strukturen.",
      ];

  let safeIndex = 0;

  function nextSafeBullet() {
    const bullet = safeBullets[safeIndex % safeBullets.length];
    safeIndex += 1;
    return bullet;
  }

  let inBulletSection = false;

  return output
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*3\)\s*Bulletpoints/i.test(line)) {
        inBulletSection = true;
        return line;
      }

      if (/^\s*4\)/.test(line)) {
        inBulletSection = false;
        return line;
      }

      if (!inBulletSection) return line;

      const match = line.match(/^(\s*)-\s+(.*)$/);
      if (!match) return line;

      const indent = match[1];
      const bullet = match[2];

      if (bannedBulletPattern.test(bullet)) {
        return indent + "- " + nextSafeBullet();
      }

      return line;
    })
    .join("\n");
}

function buildProductDescriptionFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (isEn) {
    return [
      "1) GLE Prompt Studio",
      "2) An AI tool that helps creators and solopreneurs prepare social posts, ads and landing pages faster.",
      "3) Benefits:",
      "- Faster content preparation.",
      "- Clearer structure for repeatable formats.",
      "- More consistent quality across outputs.",
      "- Built for creators and solopreneurs.",
      "- Early Access is open, future price: 19.99â‚¬/month.",
      "4) Best suited for creators and solopreneurs who want to save time when preparing content.",
      "5) Join the waitlist.",
    ].join("\n");
  }

  return [
    "1) GLE Prompt Studio",
    "2) Ein KI-Tool, das Creatorn und Solopreneuren hilft, Social Posts, Ads und Landingpages schneller vorzubereiten.",
    "3) Vorteile:",
    "- Schnellere Content-Vorbereitung.",
    "- Klarere Struktur fÃ¼r wiederholbare Formate.",
    "- Konsistentere QualitÃ¤t Ã¼ber mehrere Ausgaben hinweg.",
    "- FÃ¼r Creator und Solopreneure entwickelt.",
    "- Early Access ist geÃ¶ffnet, spÃ¤terer Preis: 19,99â‚¬/Monat.",
    "4) Geeignet fÃ¼r Creator und Solopreneure, die bei der Content-Vorbereitung Zeit sparen wollen.",
    "5) Zur Warteliste.",
  ].join("\n");
}

function getToneKey(tone = "") {
  const t = String(tone || "").toLowerCase();

  if (t.includes("locker")) return "locker";
  if (t.includes("direkt")) return "direkt";
  if (t.includes("motiv")) return "motiv";
  if (t.includes("verkauf")) return "verkauf";

  return "default";
}

function applyToneFallback(
  output,
  { kind = "", tone = "", outLang = "DE" } = {},
) {
  const key = getToneKey(tone);
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (key === "default") return output;

  if (kind === "linkedin") {
    if (isEn) return output;

    if (key === "locker") {
      return [
        "1) Content muss nicht jedes Mal bei null starten.",
        "2) GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages entspannter vorzubereiten.",
        "3)",
        "- Aus groben Ideen werden schneller klare Entwürfe.",
        "- Wiederkehrende Formate lassen sich leichter vorbereiten.",
        "- Content fühlt sich weniger chaotisch an.",
        "4) Wenn der Startpunkt klar ist, wird die Umsetzung leichter.",
        "5) Zur Warteliste.",
      ].join("\n");
    }

    if (key === "direkt") {
      return [
        "1) Hör auf, bei jedem Content-Stück neu anzufangen.",
        "2) GLE Prompt Studio gibt Creatorn und Solopreneuren schneller eine klare Struktur für Posts, Ads und Landingpages.",
        "3)",
        "- Weniger Zeitverlust bei der Vorbereitung.",
        "- Klarere Vorgaben für wiederholbare Formate.",
        "- Mehr Konsistenz über mehrere Inhalte hinweg.",
        "4) Klare Struktur spart Zeit und macht Umsetzung einfacher.",
        "5) Zur Warteliste.",
      ].join("\n");
    }

    if (key === "motiv") {
      return [
        "1) Mehr Klarheit, weniger Content-Stress.",
        "2) GLE Prompt Studio hilft Creatorn und Solopreneuren, Ideen schneller in klare Inhalte zu verwandeln.",
        "3)",
        "- Du startest nicht mehr mit einem leeren Blatt.",
        "- Wiederholbare Formate geben dir Sicherheit.",
        "- Deine Content-Qualität bleibt besser nachvollziehbar.",
        "4) Gute Inhalte entstehen leichter, wenn der Anfang klar ist.",
        "5) Zur Warteliste.",
      ].join("\n");
    }

    if (key === "verkauf") {
      return [
        "1) Content braucht Struktur, bevor er verkauft.",
        "2) GLE Prompt Studio hilft Creatorn und Solopreneuren, Posts, Ads und Landingpages klarer und schneller vorzubereiten.",
        "3)",
        "- Weniger Reibung bei der Content-Erstellung.",
        "- Klarere Botschaften für wiederholbare Formate.",
        "- Konsistentere Qualität über mehrere Ausgaben hinweg.",
        "4) Wer schneller klare Inhalte vorbereitet, kann schneller veröffentlichen.",
        "5) Zur Warteliste.",
      ].join("\n");
    }
  }

  if (kind === "social") {
    if (isEn) return output;

    if (key === "locker") {
      return [
        "Content muss nicht kompliziert sein.",
        "- Verwandle grobe Ideen schneller in klare Entwürfe.",
        "- Bereite Posts, Ads und Landingpages entspannter vor.",
        "- Halte wiederkehrende Formate leichter im Griff.",
        "- Spare Zeit, ohne jeden Text neu zu zerdenken.",
        "Zur Warteliste.",
      ].join("\n");
    }

    if (key === "direkt") {
      return [
        "Starte nicht jedes Mal bei null.",
        "- Bereite Social Posts schneller vor.",
        "- Erstelle klarere Anzeigen-Entwürfe.",
        "- Strukturiere Landingpage-Ideen gezielter.",
        "- Halte deine Content-Qualität über Formate hinweg stabil.",
        "Zur Warteliste.",
      ].join("\n");
    }

    if (key === "motiv") {
      return [
        "Mehr Klarheit. Mehr Content.",
        "- Komm schneller von der Idee zum Entwurf.",
        "- Reduziere den Druck bei der Content-Erstellung.",
        "- Nutze wiederholbare Formate für mehr Sicherheit.",
        "- Bleib bei Posts, Ads und Landingpages konsistenter.",
        "Zur Warteliste.",
      ].join("\n");
    }

    if (key === "verkauf") {
      return [
        "Mach deine Content-Vorbereitung verkaufsstärker.",
        "- Formuliere klarere Botschaften für Posts und Ads.",
        "- Bereite Landingpages mit besserer Struktur vor.",
        "- Spare Zeit bei wiederkehrenden Verkaufsformaten.",
        "- Halte Nutzen, Zielgruppe und CTA sauber zusammen.",
        "Zur Warteliste.",
      ].join("\n");
    }
  }

  return output;
}

function buildLinkedInFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (isEn) {
    return [
      "1) Good content needs structure, not more pressure.",
      "2) GLE Prompt Studio helps creators and solopreneurs prepare social posts, ads and landing pages faster.",
      "3)",
      "- Spend less time preparing content.",
      "- Keep formats clearer and easier to repeat.",
      "- Maintain more consistent quality across outputs.",
      "4) Better content starts with a clearer starting point.",
      "5) Join the waitlist.",
    ].join("\n");
  }

  return [
    "1) Content braucht Struktur, nicht mehr Druck.",
    "2) GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages schneller vorzubereiten.",
    "3)",
    "- Weniger Zeitverlust bei der Content-Erstellung.",
    "- Klarere Struktur fÃ¼r wiederholbare Formate.",
    "- Konsistentere QualitÃ¤t Ã¼ber mehrere Ausgaben hinweg.",
    "4) Gute Inhalte entstehen leichter, wenn der Startpunkt klar ist.",
    "5) Zur Warteliste.",
  ].join("\n");
}
function validateSocialPost(output) {
  const lines = String(output || "")
    .trim()
    .split("\n");
  if (lines.length !== 6) return false;

  for (let i = 1; i <= 4; i++) {
    if (!lines[i].startsWith("- ")) return false;
    if (lines[i].trim().length < 4) return false;
  }

  if (lines[5].trim().length < 6) return false;
  if (output.includes("**")) return false;

  return true;
}

function socialLooksWeak(output) {
  const s = String(output || "");

  return /Windeseile|Hohe QualitÃ¤t|ohne stundenlange Arbeit|Trage dich jetzt|trage dich jetzt|sei unter den Ersten|unter den Ersten|Sichere dir|reduziert deinen Aufwand|Anzeigen und Webseiten|Einzelunternehmer|From the outside|Reply with BETA|payment flow|technical base/i.test(
    s,
  );
}

function applyExtendedToneFallback(
  output,
  { kind = "", tone = "", outLang = "DE" } = {},
) {
  const key = getToneKey(tone);
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (key === "default") return output;
  if (isEn) return output;

  if (kind === "email") {
    if (key === "locker") {
      return [
        "1) Betreff: Content vorbereiten ohne Kopfchaos",
        "2) Einstiegssatz: Die Warteliste für GLE Prompt Studio ist geöffnet.",
        "3) Kurzer Haupttext: GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages entspannter vorzubereiten. Aus groben Ideen werden schneller klare Entwürfe.",
        "4) Vorteile:",
        "- Weniger Grübeln vor dem leeren Blatt.",
        "- Klarere Formate für wiederkehrende Inhalte.",
        "- Mehr Ruhe und Struktur bei der Content-Erstellung.",
        "5) CTA: Zur Warteliste.",
        "6) Abschlusssatz: Early Access ist geöffnet, der spätere Preis liegt bei 19,99€/Monat.",
      ].join("\n");
    }

    if (key === "direkt") {
      return [
        "1) Betreff: Spare Zeit bei Social Posts, Ads und Landingpages",
        "2) Einstiegssatz: GLE Prompt Studio ist jetzt im Early Access.",
        "3) Kurzer Haupttext: GLE Prompt Studio gibt Creatorn und Solopreneuren eine klare Struktur für Content-Entwürfe. So entstehen Posts, Ads und Landingpages schneller und wiederholbarer.",
        "4) Vorteile:",
        "- Bereite Inhalte schneller vor.",
        "- Nutze klare Strukturen statt leerer Seiten.",
        "- Halte Qualität über mehrere Ausgaben hinweg stabil.",
        "5) CTA: Zur Warteliste.",
        "6) Abschlusssatz: Early Access ist geöffnet, der spätere Preis liegt bei 19,99€/Monat.",
      ].join("\n");
    }

    if (key === "motiv") {
      return [
        "1) Betreff: Mehr Klarheit für deinen nächsten Content",
        "2) Einstiegssatz: Die Warteliste für GLE Prompt Studio ist geöffnet.",
        "3) Kurzer Haupttext: GLE Prompt Studio hilft dir, schneller von der Idee zum strukturierten Entwurf zu kommen. So wird Content-Erstellung leichter, klarer und wiederholbarer.",
        "4) Vorteile:",
        "- Starte mit mehr Sicherheit in neue Inhalte.",
        "- Reduziere Druck bei wiederkehrenden Formaten.",
        "- Baue konsistentere Content-Workflows auf.",
        "5) CTA: Zur Warteliste.",
        "6) Abschlusssatz: Early Access ist geöffnet, der spätere Preis liegt bei 19,99€/Monat.",
      ].join("\n");
    }

    if (key === "verkauf") {
      return [
        "1) Betreff: Bereite Content vor, der klarer verkauft",
        "2) Einstiegssatz: GLE Prompt Studio ist jetzt im Early Access.",
        "3) Kurzer Haupttext: GLE Prompt Studio hilft Creatorn und Solopreneuren, Posts, Ads und Landingpages mit klarerer Botschaft vorzubereiten. So werden Nutzen, Zielgruppe und CTA schneller greifbar.",
        "4) Vorteile:",
        "- Klarere Botschaften für Verkaufsformate.",
        "- Schnellere Vorbereitung von Ads und Landingpages.",
        "- Wiederholbare Struktur für bessere Content-Qualität.",
        "5) CTA: Zur Warteliste.",
        "6) Abschlusssatz: Early Access ist geöffnet, der spätere Preis liegt bei 19,99€/Monat.",
      ].join("\n");
    }
  }

  if (kind === "blog") {
    if (key === "locker") {
      return [
        "1) Titel: Content vorbereiten, ohne jedes Mal bei null zu starten",
        "2) Einleitung: Viele Creator verlieren Zeit, weil jeder neue Inhalt wieder bei einem leeren Blatt beginnt.",
        "3) Gliederung:",
        "- Warum Content oft chaotisch startet",
        "- Wie klare Formate den Prozess entspannen",
        "- Wie GLE Prompt Studio aus Ideen schneller Entwürfe macht",
        "4) Hauptteil:",
        "GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages entspannter vorzubereiten. Statt jedes Format neu zu zerdenken, entsteht ein klarer Ausgangspunkt. Das spart Zeit und macht wiederkehrende Inhalte leichter planbar.",
        "5) Fazit: Content wird einfacher, wenn der Startpunkt klar ist.",
        "6) CTA: Zur Warteliste.",
      ].join("\n");
    }

    if (key === "direkt") {
      return [
        "1) Titel: So bereitest du Content schneller vor",
        "2) Einleitung: Content-Erstellung kostet Zeit, wenn Struktur fehlt.",
        "3) Gliederung:",
        "- Wo Creator Zeit verlieren",
        "- Warum wiederholbare Formate helfen",
        "- Wie GLE Prompt Studio die Vorbereitung beschleunigt",
        "4) Hauptteil:",
        "GLE Prompt Studio gibt Creatorn und Solopreneuren eine klare Struktur für Social Posts, Ads und Landingpages. Dadurch entstehen Entwürfe schneller, Inhalte bleiben nachvollziehbarer und wiederkehrende Formate lassen sich effizienter vorbereiten.",
        "5) Fazit: Wer schneller klare Entwürfe hat, kann schneller veröffentlichen.",
        "6) CTA: Zur Warteliste.",
      ].join("\n");
    }

    if (key === "motiv") {
      return [
        "1) Titel: Mehr Klarheit für deine Content-Erstellung",
        "2) Einleitung: Gute Inhalte entstehen leichter, wenn der erste Schritt klar ist.",
        "3) Gliederung:",
        "- Warum Klarheit den Content-Prozess erleichtert",
        "- Wie wiederholbare Strukturen Sicherheit geben",
        "- Wie GLE Prompt Studio Ideen in Entwürfe verwandelt",
        "4) Hauptteil:",
        "GLE Prompt Studio unterstützt Creator und Solopreneure dabei, Ideen schneller in strukturierte Inhalte zu verwandeln. Social Posts, Ads und Landingpages bekommen einen klareren Startpunkt. Das reduziert Druck und hilft, konsistenter zu veröffentlichen.",
        "5) Fazit: Mit klarer Struktur fühlt sich Content-Erstellung leichter an.",
        "6) CTA: Zur Warteliste.",
      ].join("\n");
    }

    if (key === "verkauf") {
      return [
        "1) Titel: Wie klare Content-Strukturen bessere Marketing-Texte ermöglichen",
        "2) Einleitung: Wer verkaufen will, braucht zuerst eine klare Botschaft.",
        "3) Gliederung:",
        "- Warum unklare Inhalte weniger überzeugen",
        "- Wie Struktur Verkaufsbotschaften schärft",
        "- Wie GLE Prompt Studio Posts, Ads und Landingpages vorbereitet",
        "4) Hauptteil:",
        "GLE Prompt Studio hilft Creatorn und Solopreneuren, Verkaufsinhalte schneller vorzubereiten. Statt jedes Mal neu über Hook, Nutzen und CTA nachzudenken, entstehen strukturierte Entwürfe für Posts, Ads und Landingpages.",
        "5) Fazit: Klarere Vorbereitung führt zu klareren Botschaften.",
        "6) CTA: Zur Warteliste.",
      ].join("\n");
    }
  }

  if (kind === "video") {
    if (key === "locker") {
      return [
        "1) Hook: Kennst du dieses Content-Chaos?",
        "2) Szene / Ablauf: Zeige einen Creator mit vielen offenen Notizen, dann den Wechsel zu GLE Prompt Studio.",
        "3) Sprechertext: Content muss nicht jedes Mal kompliziert starten. GLE Prompt Studio hilft Creatorn und Solopreneuren, Posts, Ads und Landingpages entspannter vorzubereiten.",
        "4) Texteinblendungen:",
        "- Weniger Kopfchaos",
        "- Klarere Entwürfe",
        "- Wiederholbare Formate",
        "- Schneller vom Gedanken zum Inhalt",
        "5) CTA: Zur Warteliste.",
      ].join("\n");
    }

    if (key === "direkt") {
      return [
        "1) Hook: Starte Content nicht mehr bei null.",
        "2) Szene / Ablauf: Zeige eine leere Seite, dann strukturierte Entwürfe in GLE Prompt Studio.",
        "3) Sprechertext: GLE Prompt Studio gibt Creatorn und Solopreneuren klare Strukturen für Social Posts, Ads und Landingpages. So wird aus einer Idee schneller ein nutzbarer Entwurf.",
        "4) Texteinblendungen:",
        "- Schnellere Vorbereitung",
        "- Klarere Struktur",
        "- Weniger Zeitverlust",
        "- Wiederholbare Content-Formate",
        "5) CTA: Zur Warteliste.",
      ].join("\n");
    }

    if (key === "motiv") {
      return [
        "1) Hook: Deine nächste Content-Idee verdient einen klaren Start.",
        "2) Szene / Ablauf: Zeige einen Creator, der aus einer groben Idee Schritt für Schritt einen klaren Entwurf erstellt.",
        "3) Sprechertext: Mit GLE Prompt Studio wird Content-Erstellung leichter. Creator und Solopreneure bekommen schneller Struktur, Klarheit und wiederholbare Formate.",
        "4) Texteinblendungen:",
        "- Mehr Klarheit",
        "- Mehr Sicherheit",
        "- Schnellere Entwürfe",
        "- Konsistentere Inhalte",
        "5) CTA: Zur Warteliste.",
      ].join("\n");
    }

    if (key === "verkauf") {
      return [
        "1) Hook: Deine Inhalte brauchen eine klare Botschaft.",
        "2) Szene / Ablauf: Zeige Posts, Ads und Landingpages, die mit GLE Prompt Studio strukturiert vorbereitet werden.",
        "3) Sprechertext: GLE Prompt Studio hilft Creatorn und Solopreneuren, Verkaufsinhalte schneller vorzubereiten. Nutzen, Zielgruppe und CTA werden klarer zusammengeführt.",
        "4) Texteinblendungen:",
        "- Klarere Botschaften",
        "- Schnellere Ads",
        "- Strukturierte Landingpages",
        "- Bessere Content-Vorbereitung",
        "5) CTA: Zur Warteliste.",
      ].join("\n");
    }
  }

  return output;
}

function buildShortVideoFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (isEn) {
    return [
      "1) Hook: Still starting your content from a blank page?",
      "2) Scene / flow: Show a creator switching between notes, ads and landing page ideas, then opening GLE Prompt Studio.",
      "3) Voiceover: Creating content takes time when every format starts from zero. GLE Prompt Studio helps creators and solopreneurs prepare social posts, ads and landing pages faster with clearer structures.",
      "4) Text overlays:",
      "- Less time wasted",
      "- Clearer content formats",
      "- More consistent output quality",
      "- Early Access is open",
      "5) CTA: Join the waitlist.",
    ].join("\n");
  }

  return [
    "1) Hook: Startest du Content immer noch bei null?",
    "2) Szene / Ablauf: Zeige einen Creator, der zwischen Notizen, Ads und Landingpage-Ideen wechselt und dann GLE Prompt Studio öffnet.",
    "3) Sprechertext: Content-Erstellung kostet Zeit, wenn jedes Format bei null beginnt. GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages schneller mit klarer Struktur vorzubereiten.",
    "4) Texteinblendungen:",
    "- Weniger Zeitverlust",
    "- Klarere Content-Formate",
    "- Konsistentere Qualität",
    "- Early Access ist geöffnet",
    "5) CTA: Zur Warteliste.",
  ].join("\n");
}
function buildBlogFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (isEn) {
    return [
      "1) Title: How creators and solopreneurs can prepare content faster",
      "2) Introduction: Creating content often takes more time than expected. GLE Prompt Studio helps turn ideas into clearer structures faster.",
      "3) Outline:",
      "- Why content preparation slows many creators down",
      "- How clear formats save time",
      "- How GLE Prompt Studio supports repeatable content workflows",
      "4) Main section:",
      "GLE Prompt Studio helps creators and solopreneurs prepare social posts, ads and landing pages with more structure. Instead of starting from a blank page every time, users get a clearer starting point for their content. This can reduce time pressure and make output quality more consistent across different formats.",
      "5) Conclusion: Good content becomes easier when the starting point is clear.",
      "6) CTA: Join the waitlist.",
    ].join("\n");
  }

  return [
    "1) Titel: Wie Creator und Solopreneure Content schneller vorbereiten können",
    "2) Einleitung: Content-Erstellung kostet oft mehr Zeit als geplant. GLE Prompt Studio hilft dabei, Ideen schneller in klare Strukturen zu bringen.",
    "3) Gliederung:",
    "- Warum Content-Vorbereitung viele Creator ausbremst",
    "- Wie klare Formate Zeit sparen",
    "- Wie GLE Prompt Studio wiederholbare Content-Workflows unterstützt",
    "4) Hauptteil:",
    "GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages strukturierter vorzubereiten. Statt jedes Mal mit einem leeren Blatt zu starten, erhalten Nutzer einen klareren Ausgangspunkt für ihre Inhalte. Das kann Zeitdruck reduzieren und die Qualität über mehrere Formate hinweg konsistenter machen.",
    "5) Fazit: Gute Inhalte entstehen leichter, wenn der Startpunkt klar ist.",
    "6) CTA: Zur Warteliste.",
  ].join("\n");
}
function buildEmailFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (isEn) {
    return [
      "1) Subject: GLE Prompt Studio Early Access is now open",
      "2) Opening sentence: The waitlist for GLE Prompt Studio is now open.",
      "3) Short main text: GLE Prompt Studio helps creators and solopreneurs prepare social posts, ads and landing pages faster. It gives content a clearer starting point, repeatable formats and more consistent quality.",
      "4) Benefits:",
      "- Spend less time preparing content.",
      "- Keep formats clearer and easier to repeat.",
      "- Create more consistent quality across multiple outputs.",
      "5) CTA: Join the waitlist.",
      "6) Closing sentence: Early Access is open, and the future price will be 19.99€/month.",
    ].join("\n");
  }

  return [
    "1) Betreff: GLE Prompt Studio Early Access ist jetzt offen",
    "2) Einstiegssatz: Die Warteliste für GLE Prompt Studio ist jetzt geöffnet.",
    "3) Kurzer Haupttext: GLE Prompt Studio hilft Creatorn und Solopreneuren, Social Posts, Ads und Landingpages schneller vorzubereiten. So bekommen Inhalte einen klareren Startpunkt, wiederholbare Formate und konsistentere Qualität.",
    "4) Vorteile:",
    "- Weniger Zeitverlust bei der Content-Erstellung.",
    "- Klarere Struktur für wiederholbare Formate.",
    "- Konsistentere Qualität über mehrere Ausgaben hinweg.",
    "5) CTA: Zur Warteliste.",
    "6) Abschlusssatz: Early Access ist geöffnet, der spätere Preis liegt bei 19,99€/Monat.",
  ].join("\n");
}
// SOCIAL_7_LINE_HELPER
function validateSocialPost7(output) {
  const lines = String(output || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 7) return false;
  if (!lines[0] || /^[-•]/.test(lines[0])) return false;
  if (!lines[1] || /^[-•]/.test(lines[1])) return false;

  for (let i = 2; i <= 5; i += 1) {
    if (!/^[-•]\s+\S/.test(lines[i])) return false;
  }

  if (!lines[6] || /^[-•]/.test(lines[6])) return false;
  return true;
}

function socialLooksWeak7(output) {
  const lines = String(output || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const text = lines.join("\n").toLowerCase();

  if (lines.length !== 7) return true;
  if (lines.some((line) => line.length < 8)) return true;
  if (/\[[^\]]+\]/.test(text)) return true;
  if (/dein thema|deine zielgruppe|your topic|target audience/.test(text))
    return true;

  return false;
}

function buildSocialFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";
  const subject = String(topic || "").trim();

  if (isEn) {
    const safeTopic = subject || "This topic";
    return [
      `${safeTopic}: the key point at a glance.`,
      "A clear structure helps separate known information from open questions.",
      "- Focus on the central point.",
      "- Keep claims tied to the information provided.",
      "- Separate facts from assumptions.",
      "- Leave unsupported details out.",
      "Learn more about the topic.",
    ].join("\n");
  }

  const safeTopic = subject || "Dieses Thema";
  return [
    `${safeTopic}: das Wichtigste auf einen Blick.`,
    "Eine klare Struktur hilft, bekannte Informationen und offene Fragen sauber zu trennen.",
    "- Den zentralen Punkt in den Fokus stellen.",
    "- Aussagen an die vorhandenen Angaben binden.",
    "- Fakten und Annahmen klar voneinander trennen.",
    "- Nicht belegte Details weglassen.",
    "Mehr zum Thema erfahren.",
  ].join("\n");
}

// --------------------
// Landingpage / SaaS structured output helpers
// --------------------
function extractJsonObject(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

function cleanLine(value, fallback = "") {
  let s = String(value || fallback)
    .replace(/\*\*/g, "")
    .replace(/^\s*[-â€¢]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  const replacements = [
    [/\brevolution\w*\b/gi, "strukturiert"],
    [/\bblitzschnell\w*\b/gi, "schnell"],
    [/\bmagisch\w*\b/gi, "klar"],
    [/\bpremium\w*\b/gi, "PRO"],
    [/\bhochwertig\w*\b/gi, "klar"],
    [/\binnovativ\w*\b/gi, "klar strukturiert"],
    [/\bperfekt fÃ¼r\b/gi, "geeignet fÃ¼r"],
    [/\bperfekt\b/gi, "geeignet"],
    [/\bgarantiert\w*\b/gi, ""],

    [/\bohne groÃŸen Aufwand\b/gi, "ohne unnÃ¶tige Umwege"],
    [/\bohne Aufwand\b/gi, "ohne unnÃ¶tige Umwege"],
    [/\bim Handumdrehen\b/gi, "schneller"],
    [/\bauf Knopfdruck\b/gi, "mit wenigen Eingaben"],
    [/\bmÃ¼helos\b/gi, "klar"],
    [/\bansprechende\b/gi, "klare"],
    [/\beffektive\b/gi, "gezielte"],
    [/\bRekordzeit\b/gi, "klarer Struktur"],
    [
      /\bGLE Prompt Studio bietet Strukturierte Erstellung von\b/gi,
      "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r",
    ],
    [/\bStrukturierte Erstellung\b/g, "strukturierte Erstellung"],
    [
      /\bEinfache Erstellung von zielgerichteten Marketingmaterialien\b/gi,
      "Strukturierte EntwÃ¼rfe fÃ¼r Social Posts, Ads und Landingpages",
    ],
    [
      /\bSofortiger Zugriff auf kreative Tools\b/gi,
      "Early Access fÃ¼r Creator und Solopreneure",
    ],
    [
      /\bEin Tool zur schnellen Erstellung von Marketinginhalten\b/gi,
      "Ein Tool fÃ¼r strukturierte Marketinginhalte",
    ],
    [
      /\bIdeal fÃ¼r Creator und Solopreneure, die effizient arbeiten mÃ¶chten\b/gi,
      "FÃ¼r Creator und Solopreneure, die Inhalte klarer vorbereiten mÃ¶chten",
    ],

    [
      /\bGLE Prompt Studio erstellt Social Posts, Ads und Landingpages in Sekunden\b/gi,
      "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r Social Posts, Ads und Landingpages",
    ],
    [
      /\bErstelle Landingpages, die konvertieren und Ã¼berzeugen\b/gi,
      "Erstelle klare Landingpage-EntwÃ¼rfe fÃ¼r dein Angebot",
    ],
    [
      /\bGLE Prompt Studio ist ein Tool fÃ¼r Erstellung von Marketinginhalten\b/gi,
      "GLE Prompt Studio ist ein Tool fÃ¼r strukturierte Marketinginhalte",
    ],

    [
      /\bGLE Prompt Studio ermÃ¶glicht Strukturierte Erstellung von\b/gi,
      "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r",
    ],
    [
      /\bGLE Prompt Studio ist ein Tool zur schnellen Content-Erstellung\b/gi,
      "GLE Prompt Studio ist ein Tool fÃ¼r strukturierte Content-Erstellung",
    ],
    [
      /\bWas wird der Preis fÃ¼r GLE Prompt Studio sein\?/gi,
      "Was kostet GLE Prompt Studio spÃ¤ter?",
    ],
    [
      /\bGLE Prompt Studio liefert blitzschnell\b/gi,
      "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r",
    ],
    [
      /\bGLE Prompt Studio liefert schnell\b/gi,
      "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r",
    ],
    [/\bOptimiere deinen Workflow\b/gi, "Strukturiere deinen Workflow"],
    [
      /\bGLE Prompt Studio liefert in Sekunden\b/gi,
      "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r",
    ],
    [/\bliefert blitzschnell\b/gi, "erstellt strukturierte EntwÃ¼rfe fÃ¼r"],
    [/\bliefert in Sekunden\b/gi, "erstellt strukturierte EntwÃ¼rfe fÃ¼r"],
    [
      /\bKI-Tool zur schnellen Content-Erstellung\b/gi,
      "Tool fÃ¼r strukturierte Content-Erstellung",
    ],
    [
      /\bKI-Tool zur schnellen Erstellung von Inhalten\b/gi,
      "Tool fÃ¼r strukturierte Marketinginhalte",
    ],
    [/\bKI-Tool zur\b/gi, "Tool fÃ¼r"],
    [/\beffiziente Content-Erstellung\b/gi, "strukturierte Content-Erstellung"],
    [/\bschnelle Content-Erstellung\b/gi, "strukturierte Content-Erstellung"],
    [
      /\bschnelle Erstellung von Inhalten\b/gi,
      "strukturierte Erstellung von Inhalten",
    ],
    [/\bContent in Sekunden erstellen\b/gi, "Content schneller strukturieren"],
    [/\bContent in Sekunden generieren\b/gi, "Content schneller strukturieren"],
    [/\bSchnelle Erstellung\b/gi, "Strukturierte Erstellung"],
    [/\bErstelle schnell\b/gi, "Erstelle strukturiert"],
    [/\bGeneriere\b/gi, "Erstelle"],
    [/\bDesigne\b/gi, "Entwirf"],
    [/\bGestalte\b/gi, "Strukturiere"],
    [/\bautomatisierte Prozesse\b/gi, "klare Workflows"],
    [/\beffiziente Prozesse\b/gi, "klare Workflows"],
    [/\beffiziente Landingpages\b/gi, "strukturierte Landingpage-EntwÃ¼rfe"],
    [/\bHohe QualitÃ¤t\b/gi, "Konsistentere TextqualitÃ¤t"],
    [/\bhohe QualitÃ¤t\b/gi, "konsistentere TextqualitÃ¤t"],
    [/\bMinimale Zeitverluste\b/gi, "Weniger Zeitverlust"],
    [/\bMinimierung von Zeitverlust\b/gi, "Weniger Zeitverlust"],
    [/\bReduziere Zeitverlust\b/gi, "Reduziert Zeitverlust"],
    [/\bContent-Produktion\b/gi, "Content-Erstellung"],

    [/\bjetzt zur Warteliste anmelden\b/gi, "zur Warteliste"],
    [/\bJetzt eintragen\b/gi, "Zur Warteliste"],
    [/\bjetzt eintragen\b/gi, "Zur Warteliste"],
    [/\bSichere dir\b/gi, "Zur Warteliste"],
    [/\bSei unter den Ersten\b/gi, "Early Access ist geÃ¶ffnet"],
    [
      /\bWarteliste offen:\s*Early Access ist geÃ¶ffnet\.?/gi,
      "Warteliste fÃ¼r Early Access geÃ¶ffnet.",
    ],

    [/\bContent erstellen\b/gi, "Inhalte erstellen"],
    [
      /\bWer kann .* Inhalte erstellen\?/gi,
      "FÃ¼r wen ist GLE Prompt Studio gedacht?",
    ],
    [
      /\bWer kann .* Content erstellen\?/gi,
      "FÃ¼r wen ist GLE Prompt Studio gedacht?",
    ],
  ];

  for (const [rx, to] of replacements) {
    s = s.replace(rx, to);
  }

  return s
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function renderLandingpageOutput(data, outLang = "de") {
  const isEn = String(outLang || "de").toLowerCase() === "en";

  const labels = isEn
    ? {
        bullets: "Bullet points",
        cta: "CTA line",
        faq: "Mini FAQ",
        question: "Question",
        answer: "Answer",
      }
    : {
        bullets: "Bulletpoints",
        cta: "CTA-Zeile",
        faq: "Mini-FAQ",
        question: "Frage",
        answer: "Antwort",
      };

  const headline = cleanLine(
    data?.headline,
    isEn ? "Create content with more structure" : "Content klarer vorbereiten",
  );

  const subheadline = cleanLine(
    data?.subheadline,
    isEn
      ? "GLE Prompt Studio creates structured drafts for social posts, ads and landing pages."
      : "GLE Prompt Studio erstellt strukturierte EntwÃ¼rfe fÃ¼r Social Posts, Ads und Landingpages.",
  );

  const fallbackBullets = isEn
    ? [
        "Spend less time creating content.",
        "Keep content quality more consistent across formats.",
        "Create structured drafts for social posts, ads and landing pages.",
        "Clear starting points for creators and solopreneurs.",
        "Early Access is open, the future PRO price is 19.99â‚¬ per month.",
      ]
    : [
        "Weniger Zeitverlust bei der Content-Erstellung.",
        "Konsistentere TextqualitÃ¤t Ã¼ber mehrere Formate hinweg.",
        "Strukturierte EntwÃ¼rfe fÃ¼r Social Posts, Ads und Landingpages.",
        "Klare Ausgangspunkte fÃ¼r Creator und Solopreneure.",
        "Early Access ist geÃ¶ffnet, der PRO-Preis liegt spÃ¤ter bei 19,99â‚¬ pro Monat.",
      ];

  const rawBullets = Array.isArray(data?.bullets) ? data.bullets : [];

  const bullets = rawBullets
    .map((b) => cleanLine(b))
    .filter(Boolean)
    .slice(0, 5);

  for (const fallback of fallbackBullets) {
    if (bullets.length >= 5) break;
    bullets.push(cleanLine(fallback));
  }

  let cta = cleanLine(
    data?.cta,
    isEn ? "Join the waitlist." : "Zur Warteliste.",
  );

  if (isEn && /Zur Warteliste/i.test(cta)) {
    cta = "Join the waitlist.";
  }

  const fallbackFaq = isEn
    ? [
        {
          q: "What is GLE Prompt Studio?",
          a: "GLE Prompt Studio is a tool for structured marketing content.",
        },
        {
          q: "Who is GLE Prompt Studio for?",
          a: "It is built for creators and solopreneurs who want to prepare content faster.",
        },
        {
          q: "What will GLE Prompt Studio cost later?",
          a: "The planned PRO price is 19.99â‚¬ per month.",
        },
      ]
    : [
        {
          q: "Was ist GLE Prompt Studio?",
          a: "GLE Prompt Studio ist ein Tool fÃ¼r strukturierte Marketinginhalte.",
        },
        {
          q: "FÃ¼r wen ist GLE Prompt Studio gedacht?",
          a: "Es richtet sich an Creator und Solopreneure, die Inhalte klarer vorbereiten mÃ¶chten.",
        },
        {
          q: "Was kostet GLE Prompt Studio spÃ¤ter?",
          a: "Der geplante PRO-Preis liegt spÃ¤ter bei 19,99â‚¬ pro Monat.",
        },
      ];

  const rawFaq = Array.isArray(data?.faq) ? data.faq : [];

  const faq = rawFaq
    .map((item) => ({
      q: cleanLine(item?.q || item?.question || ""),
      a: cleanLine(item?.a || item?.answer || ""),
    }))
    .filter((item) => item.q && item.a)
    .slice(0, 3);

  for (const fallback of fallbackFaq) {
    if (faq.length >= 3) break;
    faq.push({
      q: cleanLine(fallback.q),
      a: cleanLine(fallback.a),
    });
  }

  return [
    `1) ${headline}`,
    `2) ${subheadline}`,
    `3) ${labels.bullets}:`,
    ...bullets.map((b) => `- ${b}`),
    `4) ${labels.cta}: ${cta}`,
    `5) ${labels.faq}:`,
    ...faq.flatMap((item) => [
      `- ${labels.question}: ${item.q}`,
      `  ${labels.answer}: ${item.a}`,
    ]),
  ].join("\n");
}

function cleanLandingOutput(output) {
  return String(output || "")
    .split("\n")
    .map((line) => {
      const bullet = line.match(/^(\s*[-â€¢]\s+)(.*)$/);

      if (bullet) {
        return `${bullet[1]}${cleanLine(bullet[2])}`;
      }

      return cleanLine(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildLandingpageJsonPrompt({ useCase, tone, topic, extra, outLang }) {
  const lang = String(outLang || "de").toLowerCase() === "en" ? "EN" : "DE";

  return `
Du bist ein prÃ¤ziser SaaS-Copywriter fÃ¼r digitale Tools.
Du schreibst klare, ruhige, verkaufbare Texte ohne Hype.

WICHTIG:
Gib ausschlieÃŸlich gÃ¼ltiges JSON aus.
Kein Markdown.
Keine Einleitung.
Keine Kommentare.
Keine ErklÃ¤rungen auÃŸerhalb des JSON.

Zielsprache: ${lang}
Use-Case: ${useCase}
Ton: ${tone}

THEMA:
${topic}

ANFORDERUNGEN:
${extra}

AUFGABE:
Erstelle eine SaaS-Hero-Sektion fÃ¼r Early Access / Warteliste.

Der Text soll:
- konkret sagen, was das Tool macht
- klar sagen, fÃ¼r wen es gedacht ist
- den Zeitgewinn und die bessere Struktur erklÃ¤ren
- Social Posts, Ads und Landingpages erwÃ¤hnen, wenn passend
- natÃ¼rlich klingen, nicht nach Werbefloskel
- ruhig, klar und professionell wirken

VERBOTENE FORMULIERUNGEN:
- mÃ¼helos
- ohne Aufwand
- im Handumdrehen
- auf Knopfdruck
- perfekt
- revolutionÃ¤r
- innovativ
- hochwertig
- Premium
- magisch
- garantiert
- sichere dir
- jetzt anmelden
- Link in Bio
- Content erstellen als Satzfragment
- Wer kann ... Content erstellen?

SPRACHREGELN:
- Keine Sie-Ansprache.
- Verwende "du" nur sparsam.
- Keine Emojis.
- Keine technischen Begriffe wie GPT, API, Modell, BYOK, Tokens.
- Keine Ã¼bertriebenen Versprechen.
- Keine leeren Claims.
- Jeder Bulletpoint muss einen konkreten Produktbezug haben.
- FAQ-Fragen mÃ¼ssen natÃ¼rlich und vollstÃ¤ndig sein.
- Antworten mÃ¼ssen vollstÃ¤ndige SÃ¤tze sein.

JSON-SCHEMA:
{
  "headline": "maximal 9 WÃ¶rter, konkreter Nutzen, kein Punkt am Ende",
  "subheadline": "ein natÃ¼rlicher Satz: was das Tool macht + fÃ¼r wen",
  "bullets": [
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug"
  ],
  "cta": "kurze neutrale CTA, z.B. Zur Warteliste.",
  "faq": [
    { "q": "Was ist GLE Prompt Studio?", "a": "Antwort als vollstÃ¤ndiger Satz." },
    { "q": "FÃ¼r wen ist GLE Prompt Studio gedacht?", "a": "Antwort als vollstÃ¤ndiger Satz." },
    { "q": "Was kostet GLE Prompt Studio spÃ¤ter?", "a": "Antwort als vollstÃ¤ndiger Satz." }
  ]
}

QUALITÃ„TSZIEL:
Der Output soll wie eine echte SaaS-Landingpage klingen, nicht wie ein generischer KI-Text.

Gib nur gÃ¼ltiges JSON aus.
`.trim();
}

// --------------------
// Express app
// --------------------
loadDb();
const app = express();

// Stripe webhook must use RAW body (before json middleware)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!stripe || !STRIPE_WEBHOOK_SECRET)
        return res.status(400).send("stripe_not_configured");

      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          STRIPE_WEBHOOK_SECRET,
        );
      } catch (err) {
        console.error("Webhook signature error:", err?.message || err);
        return res.status(400).send("invalid_signature");
      }

      const type = event.type;
      const obj = event.data?.object;

      if (type === "checkout.session.completed") {
        const session = obj;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const accountId = session?.metadata?.accountId;
        const userId = session?.metadata?.userId || "anon";

        if (accountId) {
          const acc = getOrCreateAccount(accountId, userId);
          syncStripeMode(acc);

          if (customerId) attachCustomerToAccount(acc, String(customerId));
          if (subscriptionId)
            acc.stripe.subscriptionId = String(subscriptionId);

          acc.plan = "PRO";
          scheduleSave();
        } else if (customerId) {
          const acc = getAccountByCustomer(String(customerId));
          if (acc) {
            syncStripeMode(acc);

            if (subscriptionId)
              acc.stripe.subscriptionId = String(subscriptionId);

            acc.plan = "PRO";
            scheduleSave();
          }
        }
      }

      if (
        type === "customer.subscription.created" ||
        type === "customer.subscription.updated"
      ) {
        const sub = obj;
        const customerId = String(sub.customer || "");
        const acc = getAccountByCustomer(customerId);

        if (acc) {
          syncStripeMode(acc);

          acc.stripe.subscriptionId = String(
            sub.id || acc.stripe.subscriptionId || "",
          );
          acc.stripe.status = String(sub.status || "");
          acc.stripe.currentPeriodEnd = normalizeStripeTs(
            sub.current_period_end,
          );
          acc.stripe.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
          acc.stripe.cancelAt = normalizeStripeTs(
            sub.cancel_at ||
              (sub.cancel_at_period_end ? sub.current_period_end : 0),
          );

          const stillActive = [
            "active",
            "trialing",
            "past_due",
            "unpaid",
          ].includes(String(sub.status || ""));
          if (stillActive) acc.plan = "PRO";

          scheduleSave();
        }
      }

      if (type === "customer.subscription.deleted") {
        const sub = obj;
        const customerId = String(sub.customer || "");
        const acc = getAccountByCustomer(customerId);

        if (acc) {
          syncStripeMode(acc);

          acc.stripe.status = "canceled";
          acc.stripe.cancelAtPeriodEnd = false;
          acc.stripe.cancelAt = now();
          acc.plan = "FREE";
          scheduleSave();
        }
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error("Webhook handler error:", e);
      return res.status(500).send("webhook_error");
    }
  },
);

// CORS + JSON
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigin(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "x-gle-user",
      "x-gle-user-id",
      "x-user-id",
      "x-gle-account-id",
      "x-gle-accountid",
      "x-account-id",
      "x-gle-api-key",
      "x-openai-key",
      "x-api-key",
      "x-admin-key",
    ],
    exposedHeaders: [
      "x-gle-build",
      "x-gle-engine",
      "x-gle-model",
      "x-gle-format-fix",
      "x-gle-structural-repair",
      "x-gle-request-id",
      "x-gle-provider",
    ],
  }),
);
app.use(express.json({ limit: "1mb" }));

// If CORS blocks, return JSON (not HTML)
app.use((err, req, res, next) => {
  if (err && String(err.message || "").startsWith("CORS blocked:")) {
    return res
      .status(403)
      .json({ ok: false, error: "cors_blocked", message: err.message });
  }
  return next(err);
});

// --------------------
// Routes
// --------------------
app.get("/api/health", (req, res) => {
  return res.json({
    status: "ok",
    byokOnly: BYOK_ONLY,
    stripe: !!stripe,
    stripeMode: stripeModeLabel(),
    stripePriceId: STRIPE_PRICE_ID || "",
    models: { byok: MODEL_BYOK, pro: MODEL_PRO, boost: MODEL_BOOST },
    gateway: aiGateway.health(),
    betaAccess: betaAccess.health(),
    profiles: {
      enabled: true,
      limit: PROFILE_LIMIT,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      maxProofFacts: MAX_PROOF_FACTS,
    },
    limits: { FREE_LIMIT, PRO_LIMIT, PRO_BOOST_LIMIT },
    trial: { enabled: TRIAL_ENABLED, limit24h: TRIAL_LIMIT_24H },
    bouncer: {
      enabled: BOUNCER_ENABLED,
      maxPasses: BOUNCER_MAX_PASSES,
      stemsCount: ACTIVE_BANNED_STEMS.length,
    },
    allowedOrigins: ALLOWED_ORIGINS,
    vercelProjectSlug: VERCEL_PROJECT_SLUG,
  });
});

app.get("/api/me", (req, res) => {
  try {
    const { userId, accountId } = getIds(req);
    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });

    const acc = getOrCreateAccount(accountId, userId);
    ensureMonthlyBucket(acc);

    return res.json({
      ok: true,
      plan: planIsPro(acc) ? "PRO" : "FREE",
      renewAt: computeRenewAt(acc),
      cancelAt: computeCancelAt(acc),
      stripe: {
        mode: acc.stripe?.mode || stripeModeLabel(),
        customerId: acc.stripe?.customerId || "",
        subscriptionId: acc.stripe?.subscriptionId || "",
        hasCustomerId: !!acc.stripe?.customerId,
        status: acc.stripe?.status || "",
        cancelAtPeriodEnd: !!acc.stripe?.cancelAtPeriodEnd,
      },
      usage: {
        used: Number(acc.usage?.used || 0),
        lastTs: Number(acc.usage?.lastTs || 0),
        monthKey: acc.usage?.monthKey || monthKeyFromTs(),
        boostUsed: Number(acc.usage?.boostUsed || 0),
      },
      profiles: {
        used: ensureAccountProfiles(acc).length,
        limit: PROFILE_LIMIT,
        schemaVersion: PROFILE_SCHEMA_VERSION,
      },
      limits: { FREE_LIMIT, PRO_LIMIT, PRO_BOOST_LIMIT },
    });
  } catch (e) {
    console.error("/api/me error:", e);
    return res.status(500).json({ ok: false, error: "me_failed" });
  }
});

// --------------------
// Magic Context Light: saved profiles (max 3 per Studio account)
// --------------------
app.get("/api/profiles", (req, res) => {
  try {
    const resolved = resolveBetaAccount(req, res);
    if (!resolved) return;

    const profiles = listAccountProfiles(resolved.acc);
    return res.json({
      ok: true,
      profiles,
      used: profiles.length,
      limit: PROFILE_LIMIT,
      schemaVersion: PROFILE_SCHEMA_VERSION,
    });
  } catch (error) {
    return sendProfileError(res, error);
  }
});

app.get("/api/profiles/:profileId", (req, res) => {
  try {
    const resolved = resolveBetaAccount(req, res);
    if (!resolved) return;

    const profile = getAccountProfile(resolved.acc, req.params?.profileId);
    if (!profile) {
      throw new ProfileError("profile_not_found", "profile not found", 404, {
        profileId: String(req.params?.profileId || ""),
      });
    }

    return res.json({ ok: true, profile });
  } catch (error) {
    return sendProfileError(res, error);
  }
});

app.post("/api/profiles", (req, res) => {
  try {
    const resolved = resolveBetaAccount(req, res);
    if (!resolved) return;

    const input = req.body?.profile ?? req.body ?? {};
    const profile = createAccountProfile(resolved.acc, input);
    scheduleSave();

    return res.status(201).json({
      ok: true,
      profile,
      used: ensureAccountProfiles(resolved.acc).length,
      limit: PROFILE_LIMIT,
    });
  } catch (error) {
    return sendProfileError(res, error);
  }
});

app.put("/api/profiles/:profileId", (req, res) => {
  try {
    const resolved = resolveBetaAccount(req, res);
    if (!resolved) return;

    const input = req.body?.profile ?? req.body ?? {};
    const profile = updateAccountProfile(
      resolved.acc,
      req.params?.profileId,
      input,
    );
    scheduleSave();

    return res.json({
      ok: true,
      profile,
      used: ensureAccountProfiles(resolved.acc).length,
      limit: PROFILE_LIMIT,
    });
  } catch (error) {
    return sendProfileError(res, error);
  }
});

app.delete("/api/profiles/:profileId", (req, res) => {
  try {
    const resolved = resolveBetaAccount(req, res);
    if (!resolved) return;

    const deleted = deleteAccountProfile(resolved.acc, req.params?.profileId);
    scheduleSave();

    return res.json({
      ok: true,
      deleted: true,
      profileId: deleted.id,
      used: ensureAccountProfiles(resolved.acc).length,
      limit: PROFILE_LIMIT,
    });
  } catch (error) {
    return sendProfileError(res, error);
  }
});

// Admin: set plan without DB editing
app.post("/api/admin/set-plan", (req, res) => {
  try {
    if (!ADMIN_KEY)
      return res.status(500).json({ ok: false, error: "admin_not_configured" });

    const key = String(
      req.headers["x-admin-key"] || req.body?.adminKey || "",
    ).trim();
    if (!key || key !== ADMIN_KEY)
      return res.status(401).json({ ok: false, error: "unauthorized" });

    const accountId = String(req.body?.accountId || "").trim();
    const plan = String(req.body?.plan || "")
      .trim()
      .toUpperCase();

    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });
    if (plan !== "PRO" && plan !== "FREE")
      return res.status(400).json({ ok: false, error: "bad_plan" });

    const acc = getOrCreateAccount(accountId, "admin");
    syncStripeMode(acc);

    acc.plan = plan;
    acc.updatedAt = new Date().toISOString();
    scheduleSave();

    return res.json({ ok: true, accountId, plan });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "admin_failed",
      message: String(e?.message || e),
    });
  }
});

app.post("/api/test", async (req, res) => {
  try {
    const key = getApiKey(req);
    if (!key)
      return res.status(400).json({ ok: false, error: "missing_api_key" });

    const requestId = createRequestId("gle_test");
    const result = await aiGateway.generate({
      requestId,
      stage: "api_test",
      provider: "openai",
      model: MODEL_BYOK,
      apiKeyOverride: key,
      prompt: "ping",
      temperature: 0.0,
      metadata: { route: "/api/test", mode: "BYOK" },
    });

    res.setHeader("x-gle-request-id", requestId);
    res.setHeader("x-gle-provider", result.execution.provider);
    return res.json({
      ok: true,
      requestId,
      sample: String(result.output).slice(0, 40),
    });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, error: String(e?.message || "bad_key") });
  }
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (MAINTENANCE_MODE) return denyBilling(res);
    if (!stripe || !STRIPE_PRICE_ID)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });

    if (
      STRIPE_PRICE_ID === "price_" ||
      STRIPE_PRICE_ID === "DISABLED_FOR_BETA"
    ) {
      return res.status(503).json({
        ok: false,
        error: "checkout_disabled",
        message:
          "Der PRO-Checkout ist während der Beta noch nicht verfügbar. / PRO checkout is not available during the beta yet.",
      });
    }

    const { userId, accountId } = getIds(req);
    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });

    const acc = getOrCreateAccount(accountId, userId);
    syncStripeMode(acc);

    const base = pickReturnBase(req);
    const successUrl = `${base}/checkout-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${base}/checkout-cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      metadata: { accountId: acc.accountId, userId: acc.userId },
      customer: acc.stripe?.customerId || undefined,
    });

    return res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("checkout error:", e);
    return res.status(500).json({
      ok: false,
      error: "checkout_failed",
      message: String(e?.message || ""),
    });
  }
});

app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (MAINTENANCE_MODE) return denyBilling(res);
    if (!stripe) {
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });
    }

    const { userId, accountId } = getIds(req);
    const sessionId = String(
      req.body?.sessionId || req.body?.session_id || "",
    ).trim();

    if (!accountId) {
      return res.status(400).json({ ok: false, error: "missing_account_id" });
    }
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "missing_session_id" });
    }

    const acc = getOrCreateAccount(accountId, userId);
    syncStripeMode(acc);

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    if (String(session.mode || "") !== "subscription") {
      return res.status(409).json({
        ok: false,
        error: "wrong_checkout_mode",
        checkoutMode: session.mode || "",
      });
    }

    const sessionAccountId = String(session?.metadata?.accountId || "").trim();
    if (sessionAccountId && sessionAccountId !== acc.accountId) {
      return res.status(403).json({
        ok: false,
        error: "session_account_mismatch",
      });
    }

    if (String(session.status || "") !== "complete") {
      return res.status(409).json({
        ok: false,
        error: "checkout_not_complete",
        checkoutStatus: session.status || "",
        paymentStatus: session.payment_status || "",
      });
    }

    const customerId = String(
      session.customer?.id || session.customer || "",
    ).trim();
    if (customerId) attachCustomerToAccount(acc, customerId);

    const subscription = session.subscription;
    if (!subscription || typeof subscription !== "object") {
      return res.status(409).json({
        ok: false,
        error: "missing_subscription",
      });
    }

    const subStatus = String(subscription.status || "").trim();
    const proStatuses = ["active", "trialing", "past_due", "unpaid"];

    if (!proStatuses.includes(subStatus)) {
      acc.stripe.status = subStatus;
      scheduleSave();

      return res.status(409).json({
        ok: false,
        error: "subscription_not_active",
        subscriptionStatus: subStatus,
      });
    }

    acc.stripe.subscriptionId = String(subscription.id || "");
    acc.stripe.status = subStatus;
    acc.stripe.currentPeriodEnd = normalizeStripeTs(
      subscription.current_period_end,
    );
    acc.stripe.cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
    acc.stripe.cancelAt = normalizeStripeTs(
      subscription.cancel_at ||
        (subscription.cancel_at_period_end
          ? subscription.current_period_end
          : 0),
    );

    acc.plan = "PRO";
    syncStripeMode(acc);
    scheduleSave();

    return res.json({
      ok: true,
      plan: "PRO",
      customerId: acc.stripe.customerId,
      subscriptionId: acc.stripe.subscriptionId,
      status: acc.stripe.status,
    });
  } catch (e) {
    console.error("sync error:", e);
    return res.status(500).json({
      ok: false,
      error: "sync_failed",
      message: String(e?.message || ""),
    });
  }
});

// Billing Portal handler (used by both routes)
async function handlePortalSession(req, res) {
  try {
    if (MAINTENANCE_MODE) return denyBilling(res);
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });

    const { userId, accountId } = getIds(req);
    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });

    const acc = getOrCreateAccount(accountId, userId);
    syncStripeMode(acc);

    if (!acc.stripe?.customerId)
      return res.status(400).json({ ok: false, error: "missing_customer_id" });

    const base = pickReturnBase(req);
    const returnUrl = `${base}/?from=billing`;

    const portal = await stripe.billingPortal.sessions.create({
      customer: acc.stripe.customerId,
      return_url: returnUrl,
    });

    return res.json({ ok: true, url: portal.url });
  } catch (e) {
    console.error("billing portal error:", e);
    return res.status(500).json({
      ok: false,
      error: "portal_failed",
      message: String(e?.message || ""),
    });
  }
}

app.post("/api/billing-portal", handlePortalSession);
app.post("/api/create-portal-session", handlePortalSession); // alias/fallback

// --------------------
// Generate (SINGLE ROUTE - FINAL)
// --------------------
app.post("/api/generate", async (req, res) => {
  const gatewayRequestId = createRequestId();
  res.setHeader("x-gle-request-id", gatewayRequestId);

  try {
    console.log("GLE_GENERATE_MARKER:", process.env.BUILD_TAG || "no-tag");
    res.setHeader("x-gle-build", String(process.env.BUILD_TAG || "no-tag"));

    const { userId, accountId } = getIds(req);
    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });

    const acc = getOrCreateAccount(accountId, userId);
    syncStripeMode(acc);

    // optional honeypot
    const hp = String(req.body?.hp || "").trim();
    if (hp) {
      return res.json({
        ok: true,
        output: "",
        plan: planIsPro(acc) ? "PRO" : "FREE",
      });
    }

    const betaEmail = betaAccess.normalizeEmail(
      acc?.email ||
        acc?.userEmail ||
        acc?.accountEmail ||
        req.user?.email ||
        "",
    );

    if (
      !betaAccess.isAllowed({
        email: betaEmail,
        accountId,
        userId,
      })
    ) {
      return betaAccessDeniedResponse(req, res);
    }

    const { useCase, tone, topic, extra, outLang, boost } = normalizeInputs(
      req.body,
    );
    const wantsBoost = boost === true;

    // Magic Context Light / Proof Facts are opt-in per generation request.
    // Invalid profile IDs fail before quota/model usage is consumed.
    const activeProfile = resolveGenerationProfile(acc, req.body);
    const groundingPromptBlock = buildGroundingPromptBlock({
      profile: activeProfile,
    });

    ensureMonthlyBucket(acc);

    const byokKey = getApiKey(req);
    const isPro = planIsPro(acc);

    if (BYOK_ONLY && !byokKey) {
      return res.status(400).json({
        ok: false,
        error: "byok_required",
        message: "BYOK_ONLY is enabled. Please provide x-gle-api-key.",
      });
    }

    // Decide key/mode + internal model
    let mode = "BYOK"; // BYOK | PRO_SERVER | TRIAL_SERVER
    let apiKeyToUse = byokKey;
    let modelToUse = wantsBoost ? MODEL_BOOST : isPro ? MODEL_PRO : MODEL_BYOK;
    let shouldBurnTrial = false;

    if (!byokKey) {
      if (isPro && SERVER_AI_CONFIGURED) {
        mode = "PRO_SERVER";
        apiKeyToUse = SERVER_OPENAI_KEY;
        modelToUse = wantsBoost ? MODEL_BOOST : MODEL_PRO;
      } else {
        if (SERVER_AI_CONFIGURED) {
          mode = "FREE_SERVER";
          apiKeyToUse = SERVER_OPENAI_KEY;
          modelToUse = MODEL_PRO;
          shouldBurnTrial = false;
        } else {
          return res.status(400).json({
            ok: false,
            error: "missing_api_key",
            message:
              "Kein Server-API-Key verfügbar. Bitte später erneut versuchen oder eigenen OpenAI API-Key eintragen. / No server API key available. Please try again later or add your own OpenAI API key.",
            mode,
            model: ENGINE_BYOK,
          });
        }
      }
    }

    // Public engine label
    const engineLabel = wantsBoost
      ? ENGINE_ULTRA
      : byokKey
        ? ENGINE_BYOK
        : mode === "FREE_SERVER"
          ? ENGINE_TRIAL
          : mode === "PRO_SERVER"
            ? ENGINE_PRO
            : mode === "TRIAL_SERVER"
              ? ENGINE_TRIAL
              : ENGINE_BYOK;

    res.setHeader("x-gle-engine", engineLabel);
    res.setHeader("x-gle-model", engineLabel);

    // Server-funded requests use stable GLE aliases. BYOK remains OpenAI-compatible
    // and keeps the user's selected/current model behavior unchanged.
    const gatewayAlias = byokKey
      ? null
      : wantsBoost
        ? GLE_BOOST_ALIAS
        : mode === "PRO_SERVER"
          ? GLE_PRO_ALIAS
          : GLE_TRIAL_ALIAS;

    const gatewayExecutions = [];
    let gatewayCallIndex = 0;

    async function callStudioModel({ prompt, temperature, stage }) {
      gatewayCallIndex += 1;
      const result = await aiGateway.generate({
        requestId: gatewayRequestId,
        stage:
          stage ||
          (gatewayCallIndex === 1
            ? "generate"
            : `repair_${gatewayCallIndex - 1}`),
        ...(byokKey
          ? {
              provider: "openai",
              model: modelToUse,
              apiKeyOverride: apiKeyToUse,
            }
          : { alias: gatewayAlias }),
        prompt,
        temperature,
        metadata: {
          route: "/api/generate",
          mode,
          useCase: String(useCase || "").slice(0, 80),
          boost: wantsBoost,
          contextProfileId: activeProfile?.id || null,
          contextProfileVersion: activeProfile ? Number(activeProfile.version || 1) : null,
          proofFactsCount: activeProfile?.proofFacts?.length || 0,
        },
      });

      gatewayExecutions.push(result.execution);
      if (gatewayExecutions.length === 1) {
        res.setHeader("x-gle-provider", result.execution.provider);
      }
      return result.output;
    }

    // Quota
    const shouldCountUsage = !byokKey;
    const quota = enforceQuota(acc, wantsBoost, shouldCountUsage);
    if (!quota.ok) {
      const quotaMessage =
        quota.error === "boost_requires_pro"
          ? "Boost ist nur im PRO-Plan verfügbar. / Boost is only available in the PRO plan."
          : quota.error === "boost_limit_reached"
            ? "Dein PRO-Boost-Limit für diesen Monat ist erreicht. / Your PRO boost limit for this month has been reached."
            : quota.error === "limit_reached"
              ? "Dein Monatslimit ist erreicht. / Your monthly limit has been reached."
              : "Limit erreicht oder Aktion nicht verfügbar. / Limit reached or action not available.";

      return res.status(429).json({
        ok: false,
        error: quota.error,
        message: quotaMessage,
        used: quota.used,
        limit: quota.limit,
        renewAt: quota.renewAt,
        boostUsed: quota.boostUsed,
        boostLimit: quota.boostLimit,
        mode,
        model: engineLabel,
      });
    }
    // Prompt
    const useCaseNorm = String(useCase || "")
      .trim()
      .toLowerCase();

    const isSocial =
      (useCaseNorm.includes("social") && useCaseNorm.includes("post")) ||
      useCaseNorm === "social media post";

    const isLandingPage =
      useCaseNorm.includes("landing") ||
      useCaseNorm.includes("ad-copy") ||
      useCaseNorm.includes("saas");

    const isLinkedInPost =
      useCaseNorm.includes("linkedin") && useCaseNorm.includes("post");

    const isShortVideoScript =
      useCaseNorm.includes("kurzvideo") ||
      useCaseNorm.includes("video") ||
      useCaseNorm.includes("skript") ||
      useCaseNorm.includes("script");
    const isBlogArticle =
      useCaseNorm.includes("blog") ||
      useCaseNorm.includes("artikel") ||
      useCaseNorm.includes("article");
    const isEmailPost =
      useCaseNorm === "e-mail" ||
      useCaseNorm === "email" ||
      useCaseNorm.includes("e-mail") ||
      useCaseNorm.includes("email");
    const isProductDescription =
      useCaseNorm.includes("produkt") ||
      useCaseNorm.includes("product") ||
      String(extra || "")
        .toLowerCase()
        .includes("produktbeschreibung") ||
      String(extra || "")
        .toLowerCase()
        .includes("product description");

    let masterPrompt = isLandingPage
      ? buildLandingpageJsonPromptV2({
          useCase: String(useCase || "").trim(),
          tone,
          topic,
          extra,
          outLang,
        })
      : buildMasterPrompt({
          useCase: String(useCase || "").trim(),
          tone,
          topic,
          extra: `${extra || ""}\n\n${groundingPromptBlock}`.trim(),
          outLang,
        });

    masterPrompt = `${masterPrompt}\n\n${groundingPromptBlock}`.trim();

    // 1) First pass
    let output = await callStudioModel({
      prompt: masterPrompt,
      temperature: isLandingPage ? 0.35 : 0.6,
      stage: "generate",
    });

    // Landingpage/SaaS: JSON vom Modell â†’ Backend rendert festes Format
    if (isLandingPage) {
      let parsed = extractJsonObject(output);

      // Wenn das Modell kein gÃ¼ltiges JSON liefert: einmal hart als JSON reparieren
      if (!parsed) {
        const jsonRepairPrompt = buildLandingpageJsonRepairPrompt({
          badOutput: output,
          topic,
          outLang,
        });

        const repairedJsonText = await callStudioModel({
          prompt: jsonRepairPrompt,
          temperature: 0.0,
          stage: "landingpage_json_repair",
        });

        parsed = extractJsonObject(repairedJsonText);
      }

      if (parsed) {
        output = renderLandingpageOutputV2(parsed, { outLang, topic });
        res.setHeader("x-gle-structured", "landingpage-json");
      } else {
        // Niemals rohen Modelltext ausgeben, wenn Landingpage-JSON fehlschlÃ¤gt
        output = renderLandingpageOutputV2({}, { outLang, topic });

        res.setHeader("x-gle-structured", "landingpage-json-fallback");
      }
    }

    // 1.5) Structural repair pass
    const needsStructuralRepair =
      !isSocial &&
      !isLandingPage &&
      (/^\s*\d+\)\s*$/im.test(output) ||
        /\n\s*CTA-Zeile:/i.test(output) ||
        output.split("\n").length < 5 ||
        /Content erstellen|konsistent Inhalte|Wer kann .* Content erstellen/i.test(
          output,
        ));

    if (needsStructuralRepair) {
      res.setHeader("x-gle-structural-repair", "1");

      const repairPrompt = buildRepairPrompt({
        badOutput: output,
        hits: ["structural_format"],
        useCase,
        tone,
        topic,
        extra: `${extra || ""}\n\n${groundingPromptBlock}`.trim(),
        outLang,
      });

      output = await callStudioModel({
        prompt: repairPrompt,
        temperature: 0.3,
        stage: "structural_repair",
      });
    }

    // 2) Bouncer rewrite loop
    if (BOUNCER_ENABLED && BOUNCER_MAX_PASSES > 0) {
      for (let i = 0; i < BOUNCER_MAX_PASSES; i++) {
        const hits = findStemViolations(output);
        if (!hits.length) break;

        const repair = buildRepairPrompt({
          badOutput: output,
          hits,
          useCase,
          tone,
          topic,
          extra,
          outLang,
        });

        output = await callStudioModel({
          prompt: repair,
          temperature: 0.0,
          stage: `bouncer_repair_${i + 1}`,
        });
      }
    }

    // Non-social use-cases keep the model output.
    // Old beta fallbacks used to overwrite the user's topic with GLE demo copy.
    if (
      isProductDescription &&
      !isSocial &&
      !isLinkedInPost &&
      !isEmailPost &&
      !isBlogArticle &&
      !isShortVideoScript &&
      !isLandingPage
    ) {
      res.setHeader("x-gle-product", "1");
    } else if (isEmailPost) {
      res.setHeader("x-gle-email", "1");
    } else if (isBlogArticle) {
      res.setHeader("x-gle-blog", "1");
    } else if (isShortVideoScript) {
      res.setHeader("x-gle-video", "1");
    } else if (isLinkedInPost) {
      res.setHeader("x-gle-linkedin", "1");
    }

    // Social Post: strict 7 lines OR deterministic fallback
    else if (isSocial) {
      output = stripMarkdownArtifacts(output);

      if (!validateSocialPost7(output) || socialLooksWeak7(output)) {
        output = buildSocialFallback({ outLang, topic });
      } else {
        output = output
          .trim()
          .split("\n")
          .map((l) => l.trimEnd())
          .slice(0, 7)
          .join("\n");
      }

      res.setHeader("x-gle-social", "1");
      res.setHeader("x-gle-social-valid", String(validateSocialPost7(output)));
    } else {
      res.setHeader("x-gle-social", "0");

      // Landingpage/SaaS lÃ¤uft bereits Ã¼ber JSON -> Renderer.
      // Nicht mehr durch den alten Hot-Stem-Sanitizer jagen,
      // sonst entstehen kaputte SÃ¤tze wie "Was kostet die verwenden?"
      if (!isLandingPage) {
        output = normalizeCtaLabel(output, extra);
        output = forceNeutralCTA(output, extra);
        output = hardStripHotStems(output);
      }
    }

    if (isLandingPage) {
      output = cleanLandingOutput(output);
    }

    // Final clean (do NOT flatten lines)
    output = String(output || "")
      .replace(/\u00A0/g, " ")

      // remove "link in bio"
      .replace(/^\s*link\s+in\s+(?:der\s+|meiner\s+)?bio\s*$/gim, "")
      .replace(/^\s*link\s+in\s+bio\s*$/gim, "")
      .replace(/\blink\s+in\s+(?:der\s+|meiner\s+)?bio\b/gi, "")
      .replace(/\blink\s+in\s+bio\b/gi, "")

      // remove empty CTA labels
      .replace(/\n\s*CTA(?:-Zeile)?\s*:\s*$/gim, "")

      // remove duplicated CTA endings
      .replace(/(CTA-Zeile:\s*[^\n]+)(\n+\1)+/gim, "$1")

      // remove empty bullet lines
      .replace(/^\s*[-â€¢]\s*$/gim, "")

      // normalize spacing
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")

      // collapse repeated blank lines
      .replace(/\n{3,}/g, "\n\n")

      // cleanup weird broken fragments
      .replace(/\bContent erstellen\.\b/gi, "Inhalte erstellen")
      .replace(/\bContent erstellen\b/gi, "Inhalte erstellen")
      .replace(
        /\bTeil der ersten Inhalte erstellen werden\b/gi,
        "Teil der Early-Access-Phase werden",
      )
      .replace(
        /\bTeil der ersten Content erstellen werden\b/gi,
        "Teil der Early-Access-Phase werden",
      )

      .trim();

    // --------------------
    // FINAL LANDINGPAGE FORMAT FIX â€” ganz am Ende
    // --------------------
    if (
      !isSocial &&
      !isLandingPage &&
      !isLinkedInPost &&
      !isProductDescription &&
      !isEmailPost &&
      !isBlogArticle &&
      !isShortVideoScript
    ) {
      const looksLikeNumberedLanding =
        /^\s*1\)/m.test(output) &&
        /^\s*2\)/m.test(output) &&
        /^\s*3\)/m.test(output);

      if (looksLikeNumberedLanding) {
        res.setHeader("x-gle-format-fix", "1");

        output = String(output || "")
          // 3) Inline-Bullets sauber in echte Bullet-Liste umwandeln
          .replace(/^\s*3\)\s*((?:[-â€¢]\s*.+)+)$/gim, (match, rest) => {
            const items = String(rest || "")
              .replace(/^\s*[-â€¢]\s*/, "")
              .split(/\s+[-â€¢]\s*/)
              .map((x) => x.trim())
              .filter(Boolean);

            if (!items.length) return match;

            return `3) Bulletpoints:\n- ${items.join("\n- ")}`;
          })

          // 3) leer -> 3) Bulletpoints:
          .replace(/^\s*3\)\s*$/gim, "3) Bulletpoints:")

          // 4) irgendwas -> saubere CTA-Zeile
          .replace(
            /^\s*4\)\s*(?!CTA-Zeile:).+$/gim,
            "4) CTA-Zeile: Zur Warteliste.",
          )

          // doppelte CTA-Zeile am Ende entfernen
          .replace(/\n+\s*CTA-Zeile:\s*Zur Warteliste\.\s*$/gim, "")

          // kaputte Fragmente entfernen
          .replace(
            /\bWer kann es Inhalte erstellen\?/gi,
            "FÃ¼r wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bWer kann es Content erstellen\?/gi,
            "FÃ¼r wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bWer kann .* Inhalte erstellen\?/gi,
            "FÃ¼r wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bWer kann .* Content erstellen\?/gi,
            "FÃ¼r wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bGLE Prompt Studio Inhalte erstellen\b/gi,
            "GLE Prompt Studio ist ein",
          )
          .replace(
            /\bGLE Prompt Studio Content erstellen\b/gi,
            "GLE Prompt Studio ist ein",
          )
          .replace(/\bTool Inhalte erstellen\b/gi, "Tool nutzen")
          .replace(/\bTool Content erstellen\b/gi, "Tool nutzen")

          // Sie-Form vermeiden
          .replace(/\bIhnen\b/g, "dir")
          .replace(/\bIhren\b/g, "deinen")
          .replace(/\bIhre\b/g, "deine")
          .replace(/\bIhr\b/g, "dein")
          .replace(/\bSie\b/g, "du")

          // letzte GlÃ¤ttung
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\s+([,.;:!?])/g, "$1")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
    }

    if (shouldBurnTrial) {
      markTrial(acc);
    }

    markUsage(acc, wantsBoost, shouldCountUsage);
    if (isLandingPage) {
      // The structured V2 landing-page path is topic-safe and must not inject
      // GLE-specific fallback bullets or pricing into unrelated user topics.
      res.setHeader("x-gle-landing-sanitized", "v2-topic-safe");
    }

    output = repairEncodingArtifacts(output);
    return res.json({
      ok: true,
      output,
      requestId: gatewayRequestId,
      grounding: {
        mode: "light-v1",
        profileApplied: !!activeProfile,
        profileId: activeProfile?.id || null,
        profileVersion: activeProfile ? Number(activeProfile.version || 1) : null,
        proofFactsCount: activeProfile?.proofFacts?.length || 0,
      },
      mode,
      model: engineLabel,
      plan: planIsPro(acc) ? "PRO" : "FREE",
      used: acc.usage.used,
      limit: planIsPro(acc) ? PRO_LIMIT : FREE_LIMIT,
      boostUsed: acc.usage.boostUsed,
      boostLimit: PRO_BOOST_LIMIT,
      renewAt: computeRenewAt(acc),
      cancelAt: computeCancelAt(acc),
    });
  } catch (e) {
    console.error("generate error:", e);

    if (e instanceof ProfileError) {
      return sendProfileError(res, e);
    }

    if (e instanceof GLEGatewayError) {
      const publicError = toPublicError(e);
      return res.status(Number(e.status || 500)).json({
        ...publicError,
        requestId: gatewayRequestId,
      });
    }

    return res.status(500).json({
      ok: false,
      error: "generate_failed",
      message: e?.message || String(e),
      requestId: gatewayRequestId,
    });
  }
});

// optional root
app.get("/", (req, res) =>
  res.type("text/plain").send("GLE Prompt Studio Backend OK"),
);

// Server start (top-level)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`âœ… GLE Engine Online | Port: ${PORT}`);
});
