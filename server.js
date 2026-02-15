"use strict";

/**
 * GLE Prompt Studio Backend — CLEAN FINAL (v2)
 *
 * Features:
 * - BYOK + PRO(Server-Key) + optional BYOK_ONLY
 * - Trial optional (rolling 24h) via TRIAL_ENABLED (default OFF)
 * - Quota: FREE/PRO monthly limits + Boost limit for PRO
 * - Stripe Checkout (Subscription) + Sync via session_id + Billing Portal
 * - Stripe Webhook handling (checkout.session.completed, customer.subscription.*)
 * - JSON file DB (Render persistent disk friendly via DATA_DIR)
 * - CORS allowlist (studio.getlaunchedge.com + vercel preview + ENV override)
 * - OpenAI call: Responses API + fallback Chat Completions
 * - Server-side Bouncer: banned stems scan + rewrite passes + hard fail 422
 * - ✅ CTA normalizer + neutral CTA enforcement + hot-stem sanitizer
 * - Admin endpoint: set plan PRO/FREE via ADMIN_KEY
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

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
const defaultOrigins = [
  "https://studio.getlaunchedge.com",
  "https://gle-prompt-studio.vercel.app",
];
const extraOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = Array.from(
  new Set([...defaultOrigins, ...extraOrigins]),
);

function allowedOrigin(origin) {
  if (!origin) return true; // curl/no-origin
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // allow all Vercel preview URLs
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".vercel.app")) return true;
  } catch {}
  return false;
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
      apiKeyEnc: "", // optional: saved BYOK (encrypted) if you ever want it
    };
    scheduleSave();
  } else {
    if (uid && db.accounts[id].userId !== uid) {
      db.accounts[id].userId = uid;
      scheduleSave();
    }
  }
  return db.accounts[id];
}

function getAccountByCustomer(customerId) {
  const cid = String(customerId || "").trim();
  const accId = db.customers[cid];
  if (!accId) return null;
  return db.accounts[accId] || null;
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
      h["x-gle-user"] || // ✅ fallback für deinen aktuellen Frontend-Bug
      h["x-user-id"] ||
      "",
  ).trim();

  return { accountId, userId };
}

function getApiKey(req) {
  // headers + body fallback
  return String(
    req.headers["x-gle-api-key"] ||
      req.headers["x-openai-key"] ||
      req.headers["x-api-key"] ||
      req.body?.apiKey ||
      "",
  ).trim();
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

function enforceQuota(account, wantsBoost) {
  ensureMonthlyBucket(account);
  const isPro = planIsPro(account);
  const used = Number(account.usage.used || 0);
  const limit = isPro ? PRO_LIMIT : FREE_LIMIT;

  if (used >= limit) {
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

function markUsage(account, wantsBoost) {
  ensureMonthlyBucket(account);
  account.usage.used = Number(account.usage.used || 0) + 1;
  account.usage.lastTs = now();
  if (wantsBoost)
    account.usage.boostUsed = Number(account.usage.boostUsed || 0) + 1;
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
// BOUNCER v2 — server-side quality gate
// ===============================
const BOUNCER_ENABLED = String(process.env.BOUNCER_ENABLED || "0") === "1";
const BOUNCER_MAX_PASSES = Math.max(
  0,
  Number(process.env.BOUNCER_MAX_PASSES || 0),
);

const REQUIRED_BANNED_STEMS = [
  // meta/apology / "need more info"
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
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
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
// CTA + Sanitizer (last mile)
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
    "Warteliste öffnen.",
  ];
  const chosen = allowed[0];

  const want = detectCtaLabelFromExtra(extra); // may be null
  const out = String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:\d+\)\s*)?)(CTA(?:-Zeile)?\s*:)\s*(.*)$/i);
      if (!m) return line;
      const label = want ? `${want}:` : m[2];
      return `${m[1]}${label} ${chosen}`;
    })
    .join("\n");

  // If format expects CTA but model forgot it: append one line (safe fallback)
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

/**
 * Hard sanitize the most frequent “hot stems” that keep tripping the bouncer,
 * without asking the model again.
 */
function hardStripHotStems(output) {
  let s = String(output || "");

  // remove/replace common offenders (keep it simple and safe)
  const repl = [
    // nutz* family
    [/\b(nutz\w*)\b/gi, "Content erstellen"],
    // vorsprung / vorsp*
    [/\b(vorsprung\w*)\b/gi, "klarer Schritt nach vorn"],
    [/\b(vorsp\w*)\b/gi, "klarer Schritt nach vorn"],
    // sicher*
    [/\b(sicher\w*)\b/gi, "jetzt"],
    // optimier/steiger/verbesser
    [/\b(optimier\w*|steiger\w*|verbesser\w*)\b/gi, "reduzieren"],
    // erfolg*
    [/\b(erfolg\w*)\b/gi, "Ergebnis"],
    // chance/verpass/profit/exklus/konkurrenz/agentur/leader/luxus/strateg
    [
      /\b(chanc\w*|verpass\w*|profit\w*|exklus\w*|konkurrenz\w*|agentur\w*|leader\w*|luxus\w*|strateg\w*)\b/gi,
      "",
    ],
    // buzzwords you explicitly hate often
    [/\b(hochwertig\w*|blitzschnell\w*|revolution\w*|premium\w*)\b/gi, ""],
  ];

  for (const [rx, to] of repl) s = s.replace(rx, to);

  // clean extra spaces
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
      temperature: typeof temperature === "number" ? temperature : undefined,
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
      temperature: typeof temperature === "number" ? temperature : 0.6,
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
// Input mapping (THE FIX)
// --------------------
function normalizeInputs(body) {
  const b = body || {};

  const useCase = String(
    b.useCase ?? b.use_case ?? b.uc ?? b.template ?? b.type ?? "",
  ).trim();

  const tone = String(b.tone ?? b.style ?? b.voice ?? "").trim();

  // IMPORTANT: accept both topic/extra/outLang and goal/context/language
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
// Prompt builder
// --------------------
function buildMasterPrompt({ useCase, tone, topic, extra, outLang }) {
  const lang = String(outLang || "de").toLowerCase() === "en" ? "EN" : "DE";
  const uc = String(useCase || "Allgemein").trim();
  const t = String(tone || "Neutral").trim();
  const cleanTopic = String(topic || "").trim();
  const cleanExtra = String(extra || "").trim();

  return `
Du bist ein deutscher Copywriter. Du lieferst fertigen Content.
Kein Meta, keine Rückfragen, keine Entschuldigungen.

Zielsprache: ${lang}
Use-Case: ${uc}
Ton: ${t}

HARTE REGELN:
- Keine Einleitungssätze (“Hier ist…”, “Gerne…”, “Es tut mir leid…”).
- Keine Sie-Ansprache. Nutze “du” ODER neutral ohne Pronomen.
- Keine Emojis.
- Keine Buzzwords/Floskeln (z.B. “hochwertig”, “ohne Aufwand”, “Premium”, “revolutionär”).
- Schreibe konkret: was + für wen + Ergebnis, in einfachen Worten.
- Halte CTA neutral (keine Imperative wie “Sichere dir…”).

THEMA:
${cleanTopic || "(kein Thema angegeben)"}

FORMAT / Anforderungen:
${cleanExtra || "(kein Format vorgegeben)"}

Gib ausschließlich den fertigen Output aus.
`.trim();
}

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

  return `
Du bist strenger Copy-Editor. Du lieferst FERTIGEN Content – kein Meta, keine Entschuldigungen.
Zielsprache: ${lang}
Use-Case: ${useCase}
Ton: ${tone}
Thema: ${topic}

QUALITY GATE (hart):
1) Schreibe KOMPLETT NEU. Nicht umformulieren, nichts wiederverwenden.
2) Keine Einleitungssätze, keine Erklärungen, kein “Hier ist…”.
3) Keine Entschuldigungen / kein “mir fehlen Infos” / kein “I can’t…”.
4) Keine Floskeln & kein Marketing-Pathos. Kurz, klar, konkret.
5) Keine Sie-Ansprache. Nutze “du” ODER neutral ohne Pronomen.
6) VERBOTEN: In deiner finalen Antwort darf KEIN Wortteil aus dieser Liste vorkommen:
${bannedAll || "(leer)"}
7) Treffer im letzten Output waren: ${hitList || "(keine)"} — diese müssen weg.
8) CTA neutral halten. Kein “Sichere dir…”, kein “Jetzt anmelden…”, kein Imperativ.
9) Wenn ein verbotener Stamm vorkommt: komplett neu schreiben. Nicht erwähnen.

FORMAT / Anforderungen (exakt einhalten):
${extra}

Alter Output (nur zur Analyse, NICHT wiederverwenden):
"""
${String(badOutput || "").slice(0, 2000)}
"""
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
          if (customerId) attachCustomerToAccount(acc, String(customerId));
          if (subscriptionId)
            acc.stripe.subscriptionId = String(subscriptionId);
          acc.plan = "PRO";
          scheduleSave();
        } else if (customerId) {
          const acc = getAccountByCustomer(String(customerId));
          if (acc) {
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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "x-gle-user",
      "x-gle-account-id",
      "x-gle-api-key",
      "x-openai-key",
      "x-api-key",
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
    limits: { FREE_LIMIT, PRO_LIMIT, PRO_BOOST_LIMIT },
    trial: { enabled: TRIAL_ENABLED, limit24h: TRIAL_LIMIT_24H },
    bouncer: {
      enabled: BOUNCER_ENABLED,
      maxPasses: BOUNCER_MAX_PASSES,
      stemsCount: ACTIVE_BANNED_STEMS.length,
    },
    allowedOrigins: ALLOWED_ORIGINS,
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
      limits: { FREE_LIMIT, PRO_LIMIT, PRO_BOOST_LIMIT },
    });
  } catch (e) {
    console.error("/api/me error:", e);
    return res.status(500).json({ ok: false, error: "me_failed" });
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

    const text = await callOpenAI({
      apiKey: key,
      model: MODEL_BYOK,
      prompt: "ping",
      temperature: 0.0,
    });
    return res.json({ ok: true, sample: String(text).slice(0, 40) });
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

    const { userId, accountId } = getIds(req);
    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });

    const acc = getOrCreateAccount(accountId, userId);

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
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });

    const { userId, accountId } = getIds(req);
    const sessionId = String(req.body?.sessionId || "").trim();

    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });
    if (!sessionId)
      return res.status(400).json({ ok: false, error: "missing_session_id" });

    const acc = getOrCreateAccount(accountId, userId);

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    const customerId = String(
      session.customer?.id || session.customer || "",
    ).trim();
    const subscription = session.subscription;

    if (customerId) attachCustomerToAccount(acc, customerId);

    if (subscription && typeof subscription === "object") {
      acc.stripe.subscriptionId = String(subscription.id || "");
      acc.stripe.status = String(subscription.status || "");
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
    }

    acc.plan = "PRO";
    scheduleSave();

    return res.json({
      ok: true,
      plan: "PRO",
      customerId: acc.stripe.customerId,
      subscriptionId: acc.stripe.subscriptionId,
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

// Generate
app.post("/api/generate", async (req, res) => {
  try {
    console.log("GLE_GENERATE_MARKER:", process.env.BUILD_TAG || "no-tag");
    res.setHeader("x-gle-build", String(process.env.BUILD_TAG || "no-tag"));

    const { userId, accountId } = getIds(req);
    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_account_id" });

    const acc = getOrCreateAccount(accountId, userId);

    // optional honeypot
    const hp = String(req.body?.hp || "").trim();
    if (hp) {
      return res.json({
        ok: true,
        output: "",
        plan: planIsPro(acc) ? "PRO" : "FREE",
      });
    }

    const { useCase, tone, topic, extra, outLang, boost } = normalizeInputs(
      req.body,
    );
    const wantsBoost = boost === true;

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

    // --------------------
    // Decide key/mode + INTERNAL model
    // --------------------
    let mode = "BYOK"; // BYOK | PRO_SERVER | TRIAL_SERVER
    let apiKeyToUse = byokKey;

    // Intern: echtes Modell (nie im UI anzeigen!)
    let modelToUse = wantsBoost ? MODEL_BOOST : isPro ? MODEL_PRO : MODEL_BYOK;

    if (!byokKey) {
      if (isPro && SERVER_OPENAI_KEY) {
        mode = "PRO_SERVER";
        apiKeyToUse = SERVER_OPENAI_KEY;
        modelToUse = wantsBoost ? MODEL_BOOST : MODEL_PRO;
      } else {
        const tr = trialAllowed(acc);
        if (tr.ok && SERVER_OPENAI_KEY) {
          mode = "TRIAL_SERVER";
          apiKeyToUse = SERVER_OPENAI_KEY;
          modelToUse = MODEL_PRO;
          markTrial(acc);
        } else {
          return res.status(400).json({
            ok: false,
            error: "missing_api_key",
            message:
              "No BYOK key set. Start checkout (PRO) or set your OpenAI API key.",
            trial: tr,
            mode,
            model: ENGINE_BYOK, // UI-Label
          });
        }
      }
    }

    // --------------------
    // PUBLIC engine label (UI) – NIE echte Modellnamen
    // --------------------
    const engineLabel = wantsBoost
      ? ENGINE_ULTRA
      : byokKey
        ? ENGINE_BYOK
        : mode === "TRIAL_SERVER"
          ? ENGINE_TRIAL
          : mode === "PRO_SERVER"
            ? ENGINE_PRO
            : ENGINE_BYOK;

    // Debug-Header (hilft dir sofort zu sehen was läuft)
    res.setHeader("x-gle-engine", engineLabel);
    res.setHeader("x-gle-model", modelToUse);

    // --------------------
    // Quota
    // --------------------
    const quota = enforceQuota(acc, wantsBoost);
    if (!quota.ok) {
      return res.status(429).json({
        ok: false,
        error: quota.error,
        used: quota.used,
        limit: quota.limit,
        renewAt: quota.renewAt,
        boostUsed: quota.boostUsed,
        boostLimit: quota.boostLimit,
        mode,
        model: engineLabel, // ✅ UI-Label
      });
    }

    // --------------------
    // Build prompt
    // --------------------
    const prompt = buildMasterPrompt({
      useCase,
      tone,
      topic,
      extra,
      outLang,
      boost: wantsBoost,
    });

    // --------------------
    // 1) First pass (OpenAI bekommt IMMER modelToUse)
    // --------------------
    let output = await callOpenAI({
      apiKey: apiKeyToUse,
      model: modelToUse, // ✅ wichtig
      prompt,
      temperature: 0.6,
    });

    // --------------------
    // 2) Bouncer rewrite loop (OpenAI bekommt IMMER modelToUse)
    // --------------------
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

        output = await callOpenAI({
          apiKey: apiKeyToUse,
          model: modelToUse, // ✅ wichtig
          prompt: repair,
          temperature: 0.0,
        });
      }
    }

    // ✅ last-mile enforcement
    output = normalizeCtaLabel(output, extra);
    output = forceNeutralCTA(output, extra);
    output = hardStripHotStems(output);

    // --------------------
    // FINAL CLEAN (IMMER) – Link in Bio / Whitespace
    // --------------------
    output = String(output || "")
      // ganze Zeile killen (egal ob groß/klein, mit Leerzeichen)
      .replace(/^\s*link\s+in\s+(?:der\s+|meiner\s+)?bio\s*$/gim, "")
      // inline killen
      .replace(/\blink\s+in\s+(?:der\s+|meiner\s+)?bio\b/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();

    // Nur HARD darf 422 (wenn du findViolations nutzt)
    if (BOUNCER_ENABLED && typeof findViolations === "function") {
      const { hard } = findViolations(output, DEFAULT_BANNED_STEMS);
      if (hard && hard.length) {
        return res.status(422).json({
          ok: false,
          error: "hard_violations",
          hard,
          mode,
          model: engineLabel, // ✅ UI-Label
        });
      }
    }

    markUsage(acc, wantsBoost);

    return res.json({
      ok: true,
      output,
      mode,
      model: engineLabel, // ✅ NIE mehr gpt-...
      plan: isPro ? "PRO" : "FREE",
      used: acc.usage.used,
      limit: isPro ? PRO_LIMIT : FREE_LIMIT,
      boostUsed: acc.usage.boostUsed,
      boostLimit: PRO_BOOST_LIMIT,
      renewAt: computeRenewAt(acc),
      cancelAt: computeCancelAt(acc),
    });

    // --------------------
    // LAST LINE DEFENSE (UI + Output clean)
    // --------------------
    const publicModel = wantsBoost
      ? ENGINE_ULTRA
      : mode === "TRIAL_SERVER"
        ? ENGINE_TRIAL
        : mode === "PRO_SERVER"
          ? ENGINE_PRO
          : ENGINE_BYOK;

    output = String(output || "")
      .replace(/\blink\s+in\s+(?:der\s+|meiner\s+)?bio\b/gi, "")
      .replace(/\blink\s+in\s+bio\b/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();

    return res.json({
      ok: true,
      output,
      mode,
      model: publicModel, // ✅ NIE mehr gpt-...
      plan: isPro ? "PRO" : "FREE",
      used: acc.usage.used,
      limit: isPro ? PRO_LIMIT : FREE_LIMIT,
      boostUsed: acc.usage.boostUsed,
      boostLimit: PRO_BOOST_LIMIT,
      renewAt: computeRenewAt(acc),
      cancelAt: computeCancelAt(acc),
    });
  } catch (e) {
    console.error("generate error:", e);
    return res.status(500).json({
      ok: false,
      error: "generate_failed",
      message: e?.message || String(e),
    });
  }
});
