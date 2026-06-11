"use strict";

/**
 * GLE Prompt Studio Backend — CLEAN FINAL (v2.2)
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
 * - Social Media Post: strict 6-line validator + deterministic fallback
 * - Admin endpoint: set plan PRO/FREE via ADMIN_KEY
 */

"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
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
    };
    scheduleSave();
  } else if (uid && db.accounts[id].userId !== uid) {
    db.accounts[id].userId = uid;
    scheduleSave();
  }

  syncStripeMode(db.accounts[id]);
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
      h["x-gle-user"] || // fallback für Frontend-Bug
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
// CTA + Sanitizer (last mile) — NON-social only
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
Du lieferst FERTIGEN Content. Kein Meta, keine Rückfragen, keine Entschuldigungen.

Zielsprache: ${lang}
Use-Case: ${uc}
Ton: ${t}

HARTE REGELN:
- Keine Einleitungssätze ("Hier ist...", "Gerne...", "Es tut mir leid...").
- Keine Emojis.
- Keine Buzzwords/Floskeln wie "hochwertig", "ohne Aufwand", "Premium", "revolutionär".
- Keine leeren Überschriften, keine leeren Nummernpunkte, keine leeren Bulletpoints.
- Jede nummerierte Zeile muss Inhalt haben.
- Wenn ein Format Punkt 1), 2), 3) usw. verlangt, muss jeder Punkt vollständig ausgefüllt sein.
- CTA nur einmal ausgeben.
- Wenn im Format bereits "CTA-Zeile" verlangt wird, dann KEINE zusätzliche CTA am Ende anhängen.
- CTA neutral halten, z.B. "Zur Warteliste.", "Early Access: Eintragen.", "Mehr erfahren."
- FAQ sauber schreiben: Frage und Antwort jeweils vollständig, keine halben Zeilen.
- Schreibe konkret: was + für wen + Ergebnis, in einfachen Worten.
- Ausgabe: nur der finale Content.

QUALITÄTSREGELN:
- Kein Platzhaltertext.
- Keine technischen Begriffe wie BYOK, Server-Key, Tokens, Modellname, GPT, API.
- Keine Sätze über KI oder das Tool selbst, außer das Thema verlangt es ausdrücklich.
- Kein "Link in Bio".
- Kein doppelter CTA.
- Wenn der Nutzer ein exaktes Format vorgibt, halte dieses Format ein und fülle jeden Punkt vollständig.

THEMA:
${cleanTopic || "(kein Thema angegeben)"}

FORMAT / Anforderungen (exakt einhalten und vollständig ausfüllen):
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

  // Social Media Post = strict 6 lines
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

REQUIRED STRUCTURE (EXACTLY 6 LINES):
Line 1: Hook sentence (no title).
Line 2: - Bullet point 1
Line 3: - Bullet point 2
Line 4: - Bullet point 3
Line 5: - Bullet point 4
Line 6: Specific CTA sentence with a clear action (comment/reply/click/write).

STRICT RULES:
- NO titles
- NO markdown
- NO bold (**)
- NO generic CTA
- DO NOT add lines
- DO NOT merge lines
- Output ONLY the 6 lines
- If impossible: output FORMAT_ERROR

Previous output (do NOT reuse directly):
"""
${String(badOutput || "").slice(0, 2000)}
"""
`.trim();
  }

  // Default repair for other use-cases
  return `
Du bist strenger Copy-Editor. Du lieferst FERTIGEN Content – kein Meta, keine Entschuldigungen.
Zielsprache: ${lang}
Use-Case: ${useCase}
Ton: ${tone}
Thema: ${topic}

QUALITY GATE (hart):
1) Schreibe KOMPLETT NEU. Nicht umformulieren, nichts wiederverwenden.
2) Keine Einleitungssätze, keine Erklärungen, kein “Hier ist…”.
3) Keine Entschuldigungen / kein “mir fehlen Infos”.
4) Keine Floskeln & kein Marketing-Pathos. Kurz, klar, konkret.
5) Keine Sie-Ansprache. Nutze “du” ODER neutral ohne Pronomen.
6) VERBOTEN: In deiner finalen Antwort darf KEIN Wortteil aus dieser Liste vorkommen:
${bannedAll || "(leer)"}
7) Treffer im letzten Output waren: ${hitList || "(keine)"} — diese müssen weg.
8) CTA neutral halten. Kein Imperativ.
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
// Social Post: Format Validation Helpers
// --------------------
function stripMarkdownArtifacts(s = "") {
  let out = String(s || "");
  out = out.replace(/\*\*/g, "");
  out = out.replace(/^\s*#+\s+.*$/gm, "");
  out = out.replace(/\r\n/g, "\n").trim();
  return out;
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
    "- Klarere Struktur für wiederholbare Formate.",
    "- Konsistentere Qualität über mehrere Ausgaben hinweg.",
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

  return /Windeseile|Hohe Qualität|ohne stundenlange Arbeit|Trage dich jetzt|trage dich jetzt|sei unter den Ersten|unter den Ersten|Sichere dir|reduziert deinen Aufwand|Anzeigen und Webseiten|Einzelunternehmer|From the outside|Reply with BETA|payment flow|technical base/i.test(s);
}
function buildSocialFallback({ outLang, topic }) {
  const isEn = String(outLang || "").toLowerCase() === "en";

  if (isEn) {
    return [
      "Create content with more structure.",
      "- Draft social posts, ads and landing pages faster.",
      "- Spend less time preparing content.",
      "- Keep formats clear and easy to repeat.",
      "- Maintain consistent quality across outputs.",
      "Join the waitlist.",
    ].join("\n");
  }

  return [
    "Content klarer vorbereiten.",
    "- Entwürfe für Social Posts, Ads und Landingpages schneller vorbereiten.",
    "- Weniger Zeitverlust bei der Content-Erstellung.",
    "- Formate klarer und wiederholbarer halten.",
    "- Konsistentere Qualität über mehrere Ausgaben hinweg.",
    "Zur Warteliste.",
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
    .replace(/^\s*[-•]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  const replacements = [
    [/\brevolution\w*\b/gi, "strukturiert"],
    [/\bblitzschnell\w*\b/gi, "schnell"],
    [/\bmagisch\w*\b/gi, "klar"],
    [/\bpremium\w*\b/gi, "PRO"],
    [/\bhochwertig\w*\b/gi, "klar"],
    [/\binnovativ\w*\b/gi, "klar strukturiert"],
    [/\bperfekt für\b/gi, "geeignet für"],
    [/\bperfekt\b/gi, "geeignet"],
    [/\bgarantiert\w*\b/gi, ""],

    [/\bohne großen Aufwand\b/gi, "ohne unnötige Umwege"],
    [/\bohne Aufwand\b/gi, "ohne unnötige Umwege"],
    [/\bim Handumdrehen\b/gi, "schneller"],
    [/\bauf Knopfdruck\b/gi, "mit wenigen Eingaben"],
    [/\bmühelos\b/gi, "klar"],
    [/\bansprechende\b/gi, "klare"],
    [/\beffektive\b/gi, "gezielte"],
    [/\bRekordzeit\b/gi, "klarer Struktur"],
    [
      /\bGLE Prompt Studio bietet Strukturierte Erstellung von\b/gi,
      "GLE Prompt Studio erstellt strukturierte Entwürfe für",
    ],
    [/\bStrukturierte Erstellung\b/g, "strukturierte Erstellung"],
    [
      /\bEinfache Erstellung von zielgerichteten Marketingmaterialien\b/gi,
      "Strukturierte Entwürfe für Social Posts, Ads und Landingpages",
    ],
    [
      /\bSofortiger Zugriff auf kreative Tools\b/gi,
      "Early Access für Creator und Solopreneure",
    ],
    [
      /\bEin Tool zur schnellen Erstellung von Marketinginhalten\b/gi,
      "Ein Tool für strukturierte Marketinginhalte",
    ],
    [
      /\bIdeal für Creator und Solopreneure, die effizient arbeiten möchten\b/gi,
      "Für Creator und Solopreneure, die Inhalte klarer vorbereiten möchten",
    ],

    [
      /\bGLE Prompt Studio erstellt Social Posts, Ads und Landingpages in Sekunden\b/gi,
      "GLE Prompt Studio erstellt strukturierte Entwürfe für Social Posts, Ads und Landingpages",
    ],
    [
      /\bErstelle Landingpages, die konvertieren und überzeugen\b/gi,
      "Erstelle klare Landingpage-Entwürfe für dein Angebot",
    ],
    [
      /\bGLE Prompt Studio ist ein Tool für Erstellung von Marketinginhalten\b/gi,
      "GLE Prompt Studio ist ein Tool für strukturierte Marketinginhalte",
    ],

    [
      /\bGLE Prompt Studio ermöglicht Strukturierte Erstellung von\b/gi,
      "GLE Prompt Studio erstellt strukturierte Entwürfe für",
    ],
    [
      /\bGLE Prompt Studio ist ein Tool zur schnellen Content-Erstellung\b/gi,
      "GLE Prompt Studio ist ein Tool für strukturierte Content-Erstellung",
    ],
    [
      /\bWas wird der Preis für GLE Prompt Studio sein\?/gi,
      "Was kostet GLE Prompt Studio später?",
    ],
    [
      /\bGLE Prompt Studio liefert blitzschnell\b/gi,
      "GLE Prompt Studio erstellt strukturierte Entwürfe für",
    ],
    [
      /\bGLE Prompt Studio liefert schnell\b/gi,
      "GLE Prompt Studio erstellt strukturierte Entwürfe für",
    ],
    [/\bOptimiere deinen Workflow\b/gi, "Strukturiere deinen Workflow"],
    [
      /\bGLE Prompt Studio liefert in Sekunden\b/gi,
      "GLE Prompt Studio erstellt strukturierte Entwürfe für",
    ],
    [/\bliefert blitzschnell\b/gi, "erstellt strukturierte Entwürfe für"],
    [/\bliefert in Sekunden\b/gi, "erstellt strukturierte Entwürfe für"],
    [
      /\bKI-Tool zur schnellen Content-Erstellung\b/gi,
      "Tool für strukturierte Content-Erstellung",
    ],
    [
      /\bKI-Tool zur schnellen Erstellung von Inhalten\b/gi,
      "Tool für strukturierte Marketinginhalte",
    ],
    [/\bKI-Tool zur\b/gi, "Tool für"],
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
    [/\beffiziente Landingpages\b/gi, "strukturierte Landingpage-Entwürfe"],
    [/\bHohe Qualität\b/gi, "Konsistentere Textqualität"],
    [/\bhohe Qualität\b/gi, "konsistentere Textqualität"],
    [/\bMinimale Zeitverluste\b/gi, "Weniger Zeitverlust"],
    [/\bMinimierung von Zeitverlust\b/gi, "Weniger Zeitverlust"],
    [/\bReduziere Zeitverlust\b/gi, "Reduziert Zeitverlust"],
    [/\bContent-Produktion\b/gi, "Content-Erstellung"],

    [/\bjetzt zur Warteliste anmelden\b/gi, "zur Warteliste"],
    [/\bJetzt eintragen\b/gi, "Zur Warteliste"],
    [/\bjetzt eintragen\b/gi, "Zur Warteliste"],
    [/\bSichere dir\b/gi, "Zur Warteliste"],
    [/\bSei unter den Ersten\b/gi, "Early Access ist geöffnet"],
    [
      /\bWarteliste offen:\s*Early Access ist geöffnet\.?/gi,
      "Warteliste für Early Access geöffnet.",
    ],

    [/\bContent erstellen\b/gi, "Inhalte erstellen"],
    [
      /\bWer kann .* Inhalte erstellen\?/gi,
      "Für wen ist GLE Prompt Studio gedacht?",
    ],
    [
      /\bWer kann .* Content erstellen\?/gi,
      "Für wen ist GLE Prompt Studio gedacht?",
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
      : "GLE Prompt Studio erstellt strukturierte Entwürfe für Social Posts, Ads und Landingpages.",
  );

  const fallbackBullets = isEn
    ? [
        "Spend less time creating content.",
        "Keep content quality more consistent across formats.",
        "Create structured drafts for social posts, ads and landing pages.",
        "Clear starting points for creators and solopreneurs.",
        "Early Access is open, the future PRO price is 19.99€ per month.",
      ]
    : [
        "Weniger Zeitverlust bei der Content-Erstellung.",
        "Konsistentere Textqualität über mehrere Formate hinweg.",
        "Strukturierte Entwürfe für Social Posts, Ads und Landingpages.",
        "Klare Ausgangspunkte für Creator und Solopreneure.",
        "Early Access ist geöffnet, der PRO-Preis liegt später bei 19,99€ pro Monat.",
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
          a: "The planned PRO price is 19.99€ per month.",
        },
      ]
    : [
        {
          q: "Was ist GLE Prompt Studio?",
          a: "GLE Prompt Studio ist ein Tool für strukturierte Marketinginhalte.",
        },
        {
          q: "Für wen ist GLE Prompt Studio gedacht?",
          a: "Es richtet sich an Creator und Solopreneure, die Inhalte klarer vorbereiten möchten.",
        },
        {
          q: "Was kostet GLE Prompt Studio später?",
          a: "Der geplante PRO-Preis liegt später bei 19,99€ pro Monat.",
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
      const bullet = line.match(/^(\s*[-•]\s+)(.*)$/);

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
Du bist ein präziser SaaS-Copywriter für digitale Tools.
Du schreibst klare, ruhige, verkaufbare Texte ohne Hype.

WICHTIG:
Gib ausschließlich gültiges JSON aus.
Kein Markdown.
Keine Einleitung.
Keine Kommentare.
Keine Erklärungen außerhalb des JSON.

Zielsprache: ${lang}
Use-Case: ${useCase}
Ton: ${tone}

THEMA:
${topic}

ANFORDERUNGEN:
${extra}

AUFGABE:
Erstelle eine SaaS-Hero-Sektion für Early Access / Warteliste.

Der Text soll:
- konkret sagen, was das Tool macht
- klar sagen, für wen es gedacht ist
- den Zeitgewinn und die bessere Struktur erklären
- Social Posts, Ads und Landingpages erwähnen, wenn passend
- natürlich klingen, nicht nach Werbefloskel
- ruhig, klar und professionell wirken

VERBOTENE FORMULIERUNGEN:
- mühelos
- ohne Aufwand
- im Handumdrehen
- auf Knopfdruck
- perfekt
- revolutionär
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
- Keine übertriebenen Versprechen.
- Keine leeren Claims.
- Jeder Bulletpoint muss einen konkreten Produktbezug haben.
- FAQ-Fragen müssen natürlich und vollständig sein.
- Antworten müssen vollständige Sätze sein.

JSON-SCHEMA:
{
  "headline": "maximal 9 Wörter, konkreter Nutzen, kein Punkt am Ende",
  "subheadline": "ein natürlicher Satz: was das Tool macht + für wen",
  "bullets": [
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug",
    "konkreter Bulletpoint mit Produktbezug"
  ],
  "cta": "kurze neutrale CTA, z.B. Zur Warteliste.",
  "faq": [
    { "q": "Was ist GLE Prompt Studio?", "a": "Antwort als vollständiger Satz." },
    { "q": "Für wen ist GLE Prompt Studio gedacht?", "a": "Antwort als vollständiger Satz." },
    { "q": "Was kostet GLE Prompt Studio später?", "a": "Antwort als vollständiger Satz." }
  ]
}

QUALITÄTSZIEL:
Der Output soll wie eine echte SaaS-Landingpage klingen, nicht wie ein generischer KI-Text.

Gib nur gültiges JSON aus.
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
    methods: ["GET", "POST", "OPTIONS"],
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

    // Decide key/mode + internal model
    let mode = "BYOK"; // BYOK | PRO_SERVER | TRIAL_SERVER
    let apiKeyToUse = byokKey;
    let modelToUse = wantsBoost ? MODEL_BOOST : isPro ? MODEL_PRO : MODEL_BYOK;
    let shouldBurnTrial = false;

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
          shouldBurnTrial = true;
        } else {
          return res.status(400).json({
            ok: false,
            error: "missing_api_key",
            message:
              "No BYOK key set. Start checkout (PRO) or set your OpenAI API key.",
            trial: tr,
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
        : mode === "TRIAL_SERVER"
          ? ENGINE_TRIAL
          : mode === "PRO_SERVER"
            ? ENGINE_PRO
            : ENGINE_BYOK;

    res.setHeader("x-gle-engine", engineLabel);
    res.setHeader("x-gle-model", engineLabel);

    // Quota
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

    const masterPrompt = isLandingPage
      ? buildLandingpageJsonPrompt({
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
          extra,
          outLang,
        });

    // 1) First pass
    let output = await callOpenAI({
      apiKey: apiKeyToUse,
      model: modelToUse,
      prompt: masterPrompt,
      temperature: isLandingPage ? 0.35 : 0.6,
    });

    // Landingpage/SaaS: JSON vom Modell → Backend rendert festes Format
    if (isLandingPage) {
      let parsed = extractJsonObject(output);

      // Wenn das Modell kein gültiges JSON liefert: einmal hart als JSON reparieren
      if (!parsed) {
        const jsonRepairPrompt = `
Du hast ungültigen Output geliefert.
Wandle den folgenden Inhalt in gültiges JSON um.
Gib ausschließlich JSON aus. Kein Markdown. Keine Erklärung.

JSON-SCHEMA:
{
  "headline": "maximal 9 Wörter",
  "subheadline": "ein natürlicher Satz",
  "bullets": ["Bullet 1", "Bullet 2", "Bullet 3", "Bullet 4", "Bullet 5"],
  "cta": "Zur Warteliste.",
  "faq": [
    { "q": "Frage 1", "a": "Antwort 1" },
    { "q": "Frage 2", "a": "Antwort 2" },
    { "q": "Frage 3", "a": "Antwort 3" }
  ]
}

ALTER OUTPUT:
${output}
`.trim();

        const repairedJsonText = await callOpenAI({
          apiKey: apiKeyToUse,
          model: modelToUse,
          prompt: jsonRepairPrompt,
          temperature: 0.0,
        });

        parsed = extractJsonObject(repairedJsonText);
      }

      if (parsed) {
        output = renderLandingpageOutput(parsed, outLang);
        res.setHeader("x-gle-structured", "landingpage-json");
      } else {
        // Niemals rohen Modelltext ausgeben, wenn Landingpage-JSON fehlschlägt
        output = renderLandingpageOutput(
          {
            headline: "Content schneller strukturieren",
            subheadline:
              "GLE Prompt Studio erstellt strukturierte Entwürfe für Social Posts, Ads und Landingpages.",
            bullets: [
              "Weniger Zeitverlust bei der Content-Erstellung.",
              "Klarere Entwürfe für konkrete Kanäle.",
              "Konsistentere Textqualität über mehrere Formate hinweg.",
              "Geeignet für Creator und Solopreneure.",
              "Early Access verfügbar, PRO folgt später.",
            ],
            cta: "Zur Warteliste.",
            faq: [
              {
                q: "Was ist GLE Prompt Studio?",
                a: "Ein Tool für strukturierte Social Posts, Ads und Landingpages.",
              },
              {
                q: "Für wen ist GLE Prompt Studio gedacht?",
                a: "Für Creator und Solopreneure, die Inhalte klarer vorbereiten möchten.",
              },
              {
                q: "Was kostet GLE Prompt Studio später?",
                a: "Der geplante PRO-Preis liegt später bei 19,99€ pro Monat.",
              },
            ],
          },
          outLang,
        );

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
        /Content erstellen|konsistent Inhalte|Wer kann .* Content erstellen|CTA-Zeile:\s*Zur Warteliste/i.test(
          output,
        ));
    if (needsStructuralRepair) {
      res.setHeader("x-gle-structural-repair", "1");

      const repairPrompt = `
Du bist ein strenger deutscher SaaS-Copy-Editor.

Schreibe den Content KOMPLETT NEU.
Nicht flicken. Nicht einzelne Wörter ersetzen. Komplett sauber neu ausgeben.

Zielsprache: ${outLang}
Use-Case: ${useCase}
Ton: ${tone}

THEMA:
${topic}

FORMAT MUSS EXAKT SO AUSSEHEN:

1) Headline: [maximal 9 Wörter]
2) Subheadline: [ein natürlicher Satz]
3) Bulletpoints:
- [vollständiger Bulletpoint 1]
- [vollständiger Bulletpoint 2]
- [vollständiger Bulletpoint 3]
- [vollständiger Bulletpoint 4]
- [vollständiger Bulletpoint 5]
4) CTA-Zeile: [genau 1 neutrale CTA, kein zusätzlicher CTA danach]
5) Mini-FAQ:
- Frage: [Frage 1]
  Antwort: [Antwort 1 als vollständiger Satz]
- Frage: [Frage 2]
  Antwort: [Antwort 2 als vollständiger Satz]
- Frage: [Frage 3]
  Antwort: [Antwort 3 als vollständiger Satz]

VERBOTEN:
- "3)" ohne "Bulletpoints:"
- "4)" ohne "CTA-Zeile:"
- ein zusätzlicher CTA nach Punkt 5
- "Content erstellen" als Satzfragment
- "Wer kann ... Content erstellen?"
- Sie-Form, also "Sie", "Ihr", "Ihre", "Ihren"

HARTE REGELN:
- Keine leeren Zeilen nach Nummernpunkten.
- Kein leerer Punkt wie "3)".
- Kein zusätzlicher CTA am Ende.
- Keine kaputten Sätze.
- Kein "Link in Bio".
- Kein Meta-Text.
- Keine Emojis.
- Keine technischen Begriffe wie GPT, API, Modell, BYOK.
- Schreibe natürlich, ruhig und verkaufbar.

ZUSATZANFORDERUNGEN:
${extra}

ALTER SCHLECHTER OUTPUT:
${output}

Gib nur den finalen reparierten Content aus.
`.trim();

      output = await callOpenAI({
        apiKey: apiKeyToUse,
        model: modelToUse,
        prompt: repairPrompt,
        temperature: 0.3,
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

        output = await callOpenAI({
          apiKey: apiKeyToUse,
          model: modelToUse,
          prompt: repair,
          temperature: 0.0,
        });
      }
    }

    // Social Post: strict 6 lines OR deterministic fallback
    if (isSocial) {
      output = stripMarkdownArtifacts(output);

      if (!validateSocialPost(output) || socialLooksWeak(output)) {
        output = buildSocialFallback({ outLang, topic });
      } else {
        output = output
          .trim()
          .split("\n")
          .map((l) => l.trimEnd())
          .slice(0, 6)
          .join("\n");
      }

      res.setHeader("x-gle-social", "1");
      res.setHeader("x-gle-social-valid", String(validateSocialPost(output)));
    } else {
      res.setHeader("x-gle-social", "0");

      // Landingpage/SaaS läuft bereits über JSON -> Renderer.
      // Nicht mehr durch den alten Hot-Stem-Sanitizer jagen,
      // sonst entstehen kaputte Sätze wie "Was kostet die verwenden?"
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
      .replace(/^\s*[-•]\s*$/gim, "")

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
    // FINAL LANDINGPAGE FORMAT FIX — ganz am Ende
    // --------------------
    if (!isSocial && !isLandingPage && !isLinkedInPost) {
      const looksLikeNumberedLanding =
        /^\s*1\)/m.test(output) &&
        /^\s*2\)/m.test(output) &&
        /^\s*3\)/m.test(output);

      if (looksLikeNumberedLanding) {
        res.setHeader("x-gle-format-fix", "1");

        output = String(output || "")
          // 3) Inline-Bullets sauber in echte Bullet-Liste umwandeln
          .replace(/^\s*3\)\s*((?:[-•]\s*.+)+)$/gim, (match, rest) => {
            const items = String(rest || "")
              .replace(/^\s*[-•]\s*/, "")
              .split(/\s+[-•]\s*/)
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
            "Für wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bWer kann es Content erstellen\?/gi,
            "Für wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bWer kann .* Inhalte erstellen\?/gi,
            "Für wen ist GLE Prompt Studio gedacht?",
          )
          .replace(
            /\bWer kann .* Content erstellen\?/gi,
            "Für wen ist GLE Prompt Studio gedacht?",
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

          // letzte Glättung
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\s+([,.;:!?])/g, "$1")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
    }

    if (shouldBurnTrial) {
      markTrial(acc);
    }

    markUsage(acc, wantsBoost);

    return res.json({
      ok: true,
      output,
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
    return res.status(500).json({
      ok: false,
      error: "generate_failed",
      message: e?.message || String(e),
    });
  }
});

// optional root
app.get("/", (req, res) =>
  res.type("text/plain").send("GLE Prompt Studio Backend OK"),
);

// Server start (top-level)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ GLE Engine Online | Port: ${PORT}`);
});
