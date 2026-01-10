<<<<<<< HEAD
/* server.js — GLE Prompt Studio Backend (FINAL, UNKAPUTTBAR)
   - Checkout: NIEMALS 400 nur wegen fehlendem accountId Header (Fallback + Warn-Log)
   - Logs: Request-Logs für Render Live Tail
   - Health: buildTag sichtbar (sofort sehen ob Render wirklich den richtigen Stand hat)
   - Stripe Checkout: "card" + "paypal" (PayPal bleibt), KEIN Amazon Pay
   - PRO Aktivierung: /api/sync-checkout-session + optional Stripe Webhook
*/
=======
// backend/server.js — GLE Prompt Studio Backend (CLEAN, COMPLETE)
//
// ✅ Features:
// - BYOK + PRO (Server-Key) + Boost Model
// - Limits FREE/PRO, Usage reset monthly (renewAt = 1st of next month UTC)
// - Optional Trial for FREE without BYOK (rolling window)
// - Honeypot anti-bot field
// - Stripe Checkout Subscription + Promo Codes + PayPal (via Stripe)
// - Sync Checkout Session -> sets PRO
// - Billing Portal (Manage / Invoices / Cancel)
// - Stripe Webhooks (RAW body) for:
//   checkout.session.completed
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.paid
//   invoice.payment_failed
// - File DB (JSON): default "gle_users.json" (configurable)
//
// IMPORTANT:
// - Webhook routes MUST be registered BEFORE express.json()
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const app = express();

/* ======================
<<<<<<< HEAD
   1) Config / ENV
=======
   Config
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
====================== */
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

<<<<<<< HEAD
const BUILD_TAG = String(
  process.env.BUILD_TAG || process.env.RENDER_GIT_COMMIT || "local"
).trim();
=======
const STRIPE_BILLING_RETURN_URL = String(
  process.env.STRIPE_BILLING_RETURN_URL || FRONTEND_URL
).trim();

const BUILD_TAG = String(process.env.BUILD_TAG || "").trim();
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

<<<<<<< HEAD
// Models (Responses API)
=======
// Models
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o-mini").trim();
const MODEL_BOOST = String(process.env.MODEL_BOOST || "gpt-5").trim();

<<<<<<< HEAD
const REASONING_EFFORT = String(
  process.env.REASONING_EFFORT || "low"
).trim(); // low|medium|high

const DEFAULT_MAX_OUT = Number(process.env.DEFAULT_MAX_OUT || 900);
const BOOST_MAX_OUT = Number(process.env.BOOST_MAX_OUT || 1600);

// Limits
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

// OpenAI server key (PRO ohne BYOK)
=======
// Limits
const LIMIT_FREE = Number(process.env.LIMIT_FREE || 25);
const LIMIT_PRO = Number(process.env.LIMIT_PRO || 250);

// Trial / Teaser (FREE without BYOK can use server key limited)
const TRIAL_ENABLED =
  String(process.env.TRIAL_ENABLED || "true").toLowerCase() === "true";
const TRIAL_LIMIT = Number(process.env.TRIAL_LIMIT || 3);
const TRIAL_WINDOW_SECONDS = Number(process.env.TRIAL_WINDOW_SECONDS || 86400); // 24h

// Honeypot
const HONEYPOT_FIELD = String(process.env.HONEYPOT_FIELD || "website").trim();

// OpenAI keys
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""
).trim();

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

<<<<<<< HEAD
// Du kannst beides unterstützen: STRIPE_PRICE_ID_PRO oder STRIPE_PRICE_ID
const STRIPE_PRICE_ID =
  String(process.env.STRIPE_PRICE_ID_PRO || "").trim() ||
  String(process.env.STRIPE_PRICE_ID || "").trim();

const STRIPE_SUCCESS_URL = String(
  process.env.STRIPE_SUCCESS_URL ||
    `${FRONTEND_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`
).trim();

const STRIPE_CANCEL_URL = String(
  process.env.STRIPE_CANCEL_URL || `${FRONTEND_URL}/`
).trim();

// Admin
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

// DB
const DB_FILE = String(
  process.env.DB_FILE || path.join(__dirname, "db.json")
).trim();

// CORS
const DEFAULT_ALLOWED_ORIGINS = [
  "https://studio.getlaunchedge.com",
  "https://gle-prompt-studio.vercel.app",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const ALLOWED_ORIGINS = (() => {
  const raw = String(process.env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
})();

function stripeModeFromKey(k) {
  const s = String(k || "");
  if (s.startsWith("sk_live_")) return "live";
  if (s.startsWith("sk_test_")) return "test";
  return s ? "unknown" : "disabled";
}

/* ======================
   2) Stripe init
====================== */
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const STRIPE_MODE = stripeModeFromKey(STRIPE_SECRET_KEY);

/* ======================
   3) Middleware: Logs + CORS + Body
====================== */
app.set("trust proxy", true);

// ✅ Request logs (Render Live Tail)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const origin = req.headers.origin || "-";
    const user = req.headers["x-gle-user"] || "-";
    const acc = req.headers["x-gle-account-id"] || req.headers["x-gle-acc"] || "-";
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) origin=${origin} user=${user} acc=${acc}`
    );
  });
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      // server-to-server / curl ohne Origin erlauben
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-gle-user",
      "x-gle-account-id",
      "x-gle-acc",
      "x-openai-key",
      "x-admin-token",
      "stripe-signature",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204,
  })
);

/* ======================
   4) DB (simple JSON)
====================== */
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
=======
const stripeMode = STRIPE_SECRET_KEY.startsWith("sk_test") ? "test" : "live";

let stripe = null;
try {
  if (STRIPE_SECRET_KEY) stripe = new Stripe(STRIPE_SECRET_KEY);
} catch {
  stripe = null;
}

// Allowed origins (health should show array)
function parseOrigins() {
  const env = String(process.env.CORS_ORIGINS || "").trim();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // fallback like your /api/health shows
  return [
    "https://studio.getlaunchedge.com",
    "https://gle-prompt-studio.vercel.app",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
}
const ALLOWED_ORIGINS = parseOrigins();

/* ======================
   File DB (JSON)
   Default: gle_users.json
====================== */
const DB_FILE_NAME = String(
  process.env.DB_FILE_NAME || "gle_users.json"
).trim();
const DB_FILE = path.join(__dirname, DB_FILE_NAME);

function initDB() {
  return { accounts: {} };
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
<<<<<<< HEAD
      ensureDirForFile(DB_FILE);
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, checkouts: {} }, null, 2), "utf8");
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      users: parsed.users || {},
      checkouts: parsed.checkouts || {},
    };
  } catch (e) {
    console.error("DB load error:", e);
    return { users: {}, checkouts: {} };
  }
}

let db = loadDb();

function saveDb() {
  try {
    ensureDirForFile(DB_FILE);
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error("DB save error:", e);
  }
}

function nextMonthFirstDayTs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

function resetIfNeeded(user) {
  const now = Date.now();

  if (!user.usage || typeof user.usage.used !== "number") {
    user.usage = { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 };
  }
  if (now >= Number(user.usage.renewAt || 0)) {
    user.usage.used = 0;
    user.usage.tokens = 0;
    user.usage.lastTs = 0;
    user.usage.renewAt = nextMonthFirstDayTs();
  }

  if (!user.stripe) user.stripe = { customerId: null, subscriptionId: null, status: null };
}

function ensureUser(accountId) {
  const id = String(accountId || "anon").trim() || "anon";
  if (!db.users[id]) {
    db.users[id] = {
      plan: "FREE",
      usage: { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 },
      stripe: { customerId: null, subscriptionId: null, status: null },
=======
      const fresh = initDB();
      fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), "utf-8");
      return fresh;
    }
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const db = JSON.parse(raw);
    if (!db.accounts || typeof db.accounts !== "object") db.accounts = {};
    return db;
  } catch {
    const fresh = initDB();
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), "utf-8");
    } catch {}
    return fresh;
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function safeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-zA-Z0-9_-]/g,
    ""
  );
}

/* ======================
   ID helpers
====================== */
function getUserId(req) {
  return String(
    req.headers["x-gle-user"] || req.body?.user_id || req.body?.userId || ""
  ).trim();
}

function getAccountId(req) {
  return String(
    req.headers["x-gle-account-id"] || req.body?.accountId || ""
  ).trim();
}

function ensureIds(req) {
  // for /api/me: create IDs if missing so frontend can store them
  const user_id = getUserId(req) || `u_${safeId()}`;
  const accountId = getAccountId(req) || `acc_${safeId()}`;
  return { user_id, accountId };
}

function utcNextMonthFirstMs(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return Date.UTC(y, m + 1, 1, 0, 0, 0, 0);
}

/* ======================
   User / Usage / Trial
====================== */
function ensureUser(db, accountId, user_id) {
  if (!db.accounts[accountId]) {
    db.accounts[accountId] = {
      users: {},
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveDb();
  }
<<<<<<< HEAD
  const u = db.users[id];
  resetIfNeeded(u);
=======
  const acc = db.accounts[accountId];
  if (!acc.users) acc.users = {};

  if (!acc.users[user_id]) {
    acc.users[user_id] = {
      user_id,
      accountId,
      plan: "FREE",
      usage: { used: 0, renewAt: utcNextMonthFirstMs(), tokens: 0, lastTs: 0 },
      stripe: { customerId: "", subscriptionId: "", status: "" },
      trial: { ts: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // usage reset if renewAt passed / missing
  const u = acc.users[user_id];
  if (!u.usage)
    u.usage = { used: 0, renewAt: utcNextMonthFirstMs(), tokens: 0, lastTs: 0 };

  const now = Date.now();
  if (!u.usage.renewAt || now >= Number(u.usage.renewAt)) {
    u.usage.used = 0;
    u.usage.tokens = 0;
    u.usage.lastTs = 0;
    u.usage.renewAt = utcNextMonthFirstMs();
  }

  acc.updatedAt = Date.now();
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
  u.updatedAt = Date.now();
  return u;
}

<<<<<<< HEAD
/* ======================
   5) Helpers
====================== */
function safeIdSuffix(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-24);
}

function getUserId(req) {
  return String(req.headers["x-gle-user"] || req.body?.userId || "")
    .trim()
    .slice(0, 200) || "anon";
}

// accountId optional -> fallback aus userId
function getAccountId(req) {
  const h = req.headers || {};
  const fromHeader = h["x-gle-account-id"] || h["x-gle-acc"];
  const fromBody = req.body && (req.body.accountId || req.body.acc);
  const v = String(fromHeader || fromBody || "").trim().slice(0, 200);
  return v;
}

function getByokKey(req) {
  return String(req.headers["x-openai-key"] || "").trim();
}

function computeLimit(plan) {
  return String(plan || "FREE").toUpperCase() === "PRO" ? PRO_LIMIT : FREE_LIMIT;
}

function toStripeId(v) {
  if (!v) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && typeof v.id === "string") return v.id.trim() || null;
  return null;
}

function isSubActive(status) {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "trialing";
}

function modelSupportsReasoning(modelName) {
  const m = String(modelName || "").toLowerCase();
  return m.startsWith("o1") || m.startsWith("o3") || m.includes("reasoning") || m.startsWith("gpt-5");
}

function extractOutputText(respJson) {
  if (respJson && typeof respJson.output_text === "string" && respJson.output_text.trim()) {
    return respJson.output_text.trim();
  }
  try {
    const out = respJson?.output;
    if (!Array.isArray(out)) return "";
    const texts = [];
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if ((c?.type === "output_text" || c?.type === "text") && typeof c?.text === "string") {
          texts.push(c.text);
        }
      }
    }
    return texts.join("\n").trim();
  } catch {
    return "";
  }
}

function buildPromptFromFields(body) {
  const useCase = String(body?.useCase || "").trim();
  const tone = String(body?.tone || "").trim();
  const language = String(body?.language || "Deutsch").trim();
  const topic = String(body?.topic || "").trim();
  const extra = String(body?.extra || "").trim();

  return [
    `Du bist ein Profi-Copywriter & Prompt-Engineer.`,
    `Erstelle einen hochwertigen Output für folgenden Auftrag.`,
    ``,
    `UseCase: ${useCase || "-"}`,
    `Ton: ${tone || "-"}`,
    `Sprache: ${language || "-"}`,
    `Thema: ${topic || "-"}`,
    `Zusatz: ${extra || "-"}`,
    ``,
    `Gib nur den finalen Text aus (keine Erklärungen, kein JSON).`,
  ].join("\n");
}

async function callOpenAI({ apiKey, model, input, maxOut, reasoningEffort }) {
  const url = "https://api.openai.com/v1/responses";
  const payload = { model, input, max_output_tokens: maxOut };

  if (reasoningEffort && modelSupportsReasoning(model)) {
    payload.reasoning = { effort: String(reasoningEffort) };
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);

  const r = await fetch(url, {
    method: "POST",
    signal: ac.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).finally(() => clearTimeout(timeout));

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || `OpenAI error (${r.status})`;
    throw Object.assign(new Error(msg), { raw: data, status: r.status });
  }

  const text = extractOutputText(data);
  const tokens =
    data?.usage?.total_tokens ??
    Number(data?.usage?.output_tokens || 0) + Number(data?.usage?.input_tokens || 0);

  return { text: String(text || "").trim(), tokens: Number(tokens || 0), raw: data };
}

/* ======================
   6) Webhook RAW (MUSS vor JSON parser sein)
====================== */
=======
function limitsForPlan(plan) {
  return plan === "PRO" ? LIMIT_PRO : LIMIT_FREE;
}

function trialState(user) {
  const now = Date.now();
  const windowMs = TRIAL_WINDOW_SECONDS * 1000;

  user.trial = user.trial || { ts: [] };
  const ts = Array.isArray(user.trial.ts) ? user.trial.ts : [];
  const pruned = ts.filter((t) => Number(t) && Number(t) >= now - windowMs);

  const used = pruned.length;
  const remaining = Math.max(0, TRIAL_LIMIT - used);

  return { pruned, used, remaining };
}

function consumeTrial(user) {
  const st = trialState(user);
  if (!TRIAL_ENABLED) return { ok: false, error: "trial_disabled" };
  if (st.remaining <= 0) return { ok: false, error: "trial_exhausted" };

  user.trial.ts = [...st.pruned, Date.now()];
  return { ok: true };
}

/* ======================
   OpenAI helpers
====================== */
function pickOutput(respJson) {
  // Responses API can return output_text
  const t =
    respJson?.output_text ||
    respJson?.result ||
    respJson?.text ||
    respJson?.output ||
    "";
  return String(t || "").trim();
}

function extractTokens(respJson) {
  const u = respJson?.usage || {};
  const total =
    Number(u.total_tokens) ||
    Number(u.totalTokens) ||
    Number(u.input_tokens || 0) + Number(u.output_tokens || 0) ||
    Number(u.inputTokens || 0) + Number(u.outputTokens || 0) ||
    0;
  return Number.isFinite(total) ? total : 0;
}

/* ======================
   Stripe helpers (DB lookup)
====================== */
function findUserByCustomerId(db, customerId) {
  const cid = String(customerId || "").trim();
  if (!cid) return null;

  for (const [accId, acc] of Object.entries(db.accounts || {})) {
    const users = acc?.users || {};
    for (const [uid, u] of Object.entries(users)) {
      if (String(u?.stripe?.customerId || "").trim() === cid) {
        return { accountId: accId, user_id: uid, user: u };
      }
    }
  }
  return null;
}

function resolveUserFromStripeObject(db, obj) {
  // prefer metadata
  const metaAcc = String(
    obj?.metadata?.accountId || obj?.metadata?.acc || ""
  ).trim();
  const metaUser = String(
    obj?.metadata?.userId || obj?.metadata?.user_id || ""
  ).trim();

  if (metaAcc && metaUser) {
    const user = ensureUser(db, metaAcc, metaUser);
    return { accountId: metaAcc, user_id: metaUser, user };
  }
  if (metaAcc && !metaUser) {
    // fallback: first user in account or create anon
    const user = ensureUser(db, metaAcc, "anon");
    return { accountId: metaAcc, user_id: "anon", user };
  }

  // fallback customer lookup
  if (obj?.customer) return findUserByCustomerId(db, obj.customer);

  return null;
}

/* ======================
   Stripe Webhook (RAW)
   MUST be BEFORE express.json()
====================== */
async function handleStripeEvent(event) {
  const type = event.type;
  const obj = event.data.object;

  const db = readDB();
  const hit = resolveUserFromStripeObject(db, obj);

  // If we can't resolve, still acknowledge (Stripe will retry otherwise)
  if (!hit) {
    writeDB(db);
    return;
  }

  const user = hit.user;
  user.stripe = user.stripe || {};

  // checkout.session.completed -> set PRO and save IDs
  if (type === "checkout.session.completed") {
    const paid =
      String(obj?.payment_status || "").toLowerCase() === "paid" ||
      String(obj?.status || "").toLowerCase() === "complete";

    if (paid) {
      user.plan = "PRO";

      user.stripe.customerId = String(
        obj?.customer || user.stripe.customerId || ""
      ).trim();
      user.stripe.subscriptionId = String(
        obj?.subscription || user.stripe.subscriptionId || ""
      ).trim();

      // checkout-session hat i.d.R. kein cancel_at_period_end/current_period_end
      // → setzen wir sauber auf default
      user.stripe.status = "active";
      user.stripe.cancelAtPeriodEnd = false;
      user.stripe.currentPeriodEnd = null;

      user.updatedAt = Date.now();
      writeDB(db);
    }
    return;
  }

  // subscription created/updated
  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated"
  ) {
    const status = String(obj?.status || "").toLowerCase();

    // PRO solange aktiv / trialing / past_due (Grace-Phase)
    const shouldBePro =
      status === "active" || status === "trialing" || status === "past_due";

    // NEW: Kündigung zum Periodenende + Period-End speichern
    const cancelAtPeriodEnd = !!obj?.cancel_at_period_end;

    // Stripe liefert Sekunden (unix) → wir speichern ms
    const currentPeriodEndSec = Number(obj?.current_period_end || 0);
    const currentPeriodEnd = currentPeriodEndSec
      ? currentPeriodEndSec * 1000
      : null;

    user.plan = shouldBePro ? "PRO" : "FREE";

    user.stripe.customerId = String(
      obj?.customer || user.stripe.customerId || ""
    ).trim();
    user.stripe.subscriptionId = String(
      obj?.id || user.stripe.subscriptionId || ""
    ).trim();

    user.stripe.status = status;
    user.stripe.cancelAtPeriodEnd = cancelAtPeriodEnd;
    user.stripe.currentPeriodEnd = currentPeriodEnd;

    user.updatedAt = Date.now();
    writeDB(db);
    return;
  }

  // subscription deleted -> FREE
  if (type === "customer.subscription.deleted") {
    user.plan = "FREE";

    user.stripe.customerId = String(
      obj?.customer || user.stripe.customerId || ""
    ).trim();
    user.stripe.subscriptionId = "";
    user.stripe.status = "canceled";

    // NEW: reset cancel flags
    user.stripe.cancelAtPeriodEnd = false;
    user.stripe.currentPeriodEnd = null;

    user.updatedAt = Date.now();
    writeDB(db);
    return;
  }
}

function stripeWebhookHandler(req, res) {
  if (!stripe) return res.status(500).send("stripe_not_configured");
  if (!STRIPE_WEBHOOK_SECRET)
    return res.status(500).send("webhook_secret_missing");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ webhook verify failed:", err?.message || err);
    return res.status(400).send("webhook_signature_invalid");
  }

  handleStripeEvent(event)
    .then(() => res.json({ received: true }))
    .catch((e) => {
      console.error("❌ webhook handler error:", e);
      res.status(500).send("webhook_handler_error");
    });
}

// Stripe Dashboard endpoint uses /api/stripe/webhook
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
<<<<<<< HEAD
  async (req, res) => {
    try {
      if (!stripe) return res.status(500).send("stripe_not_configured");

      let event;
      if (STRIPE_WEBHOOK_SECRET) {
        const sig = req.headers["stripe-signature"];
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body.toString("utf8"));
      }

      const type = event?.type || "";
      const obj = event?.data?.object || {};

      async function setProForAccount(accountId, subMaybe, cusMaybe, statusMaybe) {
        if (!accountId) return;
        const u = ensureUser(accountId);

        const subId = toStripeId(subMaybe) || toStripeId(u?.stripe?.subscriptionId);
        let cusId = toStripeId(cusMaybe) || toStripeId(u?.stripe?.customerId);

        if (!cusId && subId) {
          const s = await stripe.subscriptions.retrieve(subId);
          cusId = toStripeId(s?.customer);
        }

        const st = String(statusMaybe || u?.stripe?.status || "").toLowerCase();
        const active = isSubActive(st);

        u.plan = active ? "PRO" : "FREE";
        u.stripe = u.stripe || {};
        u.stripe.subscriptionId = subId || null;
        u.stripe.customerId = cusId || null;
        u.stripe.status = st || null;

        u.updatedAt = Date.now();
      }

      if (type === "checkout.session.completed") {
        const sessionStatus = String(obj?.status || "").toLowerCase();
        const paymentStatus = String(obj?.payment_status || "").toLowerCase();
        const completed = sessionStatus === "complete" || paymentStatus === "paid";

        const accountId = String(obj?.metadata?.accountId || "").trim();
        if (completed && accountId) {
          await setProForAccount(accountId, obj?.subscription, obj?.customer, "active");
        }
      }

      if (type.startsWith("customer.subscription.")) {
        const subId = toStripeId(obj?.id);
        const cusId = toStripeId(obj?.customer);
        const st = String(obj?.status || "").toLowerCase();
        const accountId = String(obj?.metadata?.accountId || "").trim();

        if (accountId) {
          await setProForAccount(accountId, subId, cusId, st);
        } else {
          // Fallback: match per customerId in DB
          const keys = Object.keys(db.users || {});
          const match = keys.find((k) => {
            const u = db.users[k];
            const c = toStripeId(u?.stripe?.customerId);
            return c && cusId && c === cusId;
          });
          if (match) await setProForAccount(match, subId, cusId, st);
        }
      }

      saveDb();
      return res.json({ received: true });
    } catch (e) {
      console.error("webhook error:", e?.message || e);
      return res.status(400).send(`Webhook Error: ${e?.message || "unknown"}`);
    }
  }
);

/* ======================
   7) JSON Body für alles andere
====================== */
app.use(express.json({ limit: "1mb" }));

/* ======================
   8) Routes
====================== */
app.get("/", (req, res) => res.send("GLE Prompt Studio Backend OK"));

=======
  stripeWebhookHandler
);
// Alias (optional)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

/* ======================
   Middleware (CORS + JSON)
====================== */
app.use(
  cors({
    origin: function (origin, cb) {
      // allow non-browser / curl
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin), false);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "x-gle-user",
      "x-gle-account-id",
      "x-openai-key",
      "stripe-signature",
    ],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

/* ======================
   Stripe Webhook (RAW)
   MUST be BEFORE express.json()
====================== */

// Helpers (namen bewusst spezifisch, damit nix kollidiert)
function stripeBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}
function stripeSecToMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Stripe liefert meist Sekunden → ms
  // Wenn jemand ms schicken würde (sehr groß), lassen wir es durch:
  return n > 10_000_000_000 ? n : n * 1000;
}

async function handleStripeEvent(event) {
  const type = event.type;
  const obj = event.data.object;

  const db = readDB();
  const hit = resolveUserFromStripeObject(db, obj);

  // Wenn wir nicht zuordnen können: trotzdem ACK, sonst retry-loop
  if (!hit) {
    // kein write nötig
    return;
  }

  const user = hit.user;
  user.stripe = user.stripe || {};

  // ---- 1) Checkout completed (setzt PRO + speichert IDs) ----
  if (type === "checkout.session.completed") {
    const paid =
      String(obj?.payment_status || "").toLowerCase() === "paid" ||
      String(obj?.status || "").toLowerCase() === "complete";

    if (paid) {
      const customerId = String(
        obj?.customer || user.stripe.customerId || ""
      ).trim();
      const subscriptionId = String(
        obj?.subscription || user.stripe.subscriptionId || ""
      ).trim();

      user.plan = "PRO";
      user.stripe.customerId = customerId || user.stripe.customerId || "";
      user.stripe.subscriptionId =
        subscriptionId || user.stripe.subscriptionId || "";
      user.stripe.status = "active";

      // checkout session kennt i.d.R. keine period_end infos → lassen wir leer
      user.updatedAt = Date.now();
      writeDB(db);
    }
    return;
  }

  // ---- 2) Subscription created/updated (inkl. cancel_at_period_end) ----
  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated"
  ) {
    const status = String(obj?.status || "").toLowerCase();

    const customerId = String(
      obj?.customer || user.stripe.customerId || ""
    ).trim();
    const subscriptionId = String(
      obj?.id || user.stripe.subscriptionId || ""
    ).trim();

    const cancelAtPeriodEnd = stripeBool(obj?.cancel_at_period_end);
    const currentPeriodEndMs = stripeSecToMs(obj?.current_period_end);
    const cancelAtMs = stripeSecToMs(obj?.cancel_at);
    const canceledAtMs = stripeSecToMs(obj?.canceled_at);

    // PRO nur wenn active / trialing (auch wenn cancel_at_period_end=true bleibt es PRO bis zum Ende)
    const isPro = status === "active" || status === "trialing";

    user.plan = isPro ? "PRO" : "FREE";

    user.stripe.customerId = customerId || user.stripe.customerId || "";
    user.stripe.subscriptionId =
      subscriptionId || user.stripe.subscriptionId || "";
    user.stripe.status = status;

    // neue Felder (für UI: "gekündigt zum ...")
    user.stripe.cancelAtPeriodEnd = cancelAtPeriodEnd;
    if (currentPeriodEndMs) user.stripe.currentPeriodEnd = currentPeriodEndMs;
    if (cancelAtMs) user.stripe.cancelAt = cancelAtMs;
    if (canceledAtMs) user.stripe.canceledAt = canceledAtMs;

    user.updatedAt = Date.now();
    writeDB(db);
    return;
  }

  // ---- 3) Subscription deleted (jetzt wirklich FREE) ----
  if (type === "customer.subscription.deleted") {
    user.plan = "FREE";

    user.stripe.status = "canceled";
    user.stripe.cancelAtPeriodEnd = false;

    // subscriptionId kann leer, customerId behalten wir
    user.stripe.subscriptionId = "";
    user.updatedAt = Date.now();
    writeDB(db);
    return;
  }

  // ---- 4) Invoices (nur Status speichern; Plan lassen wir wie er ist) ----
  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    user.stripe.lastInvoiceStatus =
      type === "invoice.paid" ? "paid" : "payment_failed";

    // Optional: wenn payment_failed → status im Abo könnte später past_due werden (kommt via subscription.updated)
    user.updatedAt = Date.now();
    writeDB(db);
    return;
  }

  // default ignore
  return;
}

function stripeWebhookHandler(req, res) {
  if (!stripe) return res.status(500).send("stripe_not_configured");
  if (!STRIPE_WEBHOOK_SECRET)
    return res.status(500).send("webhook_secret_missing");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ webhook verify failed:", err?.message || err);
    return res.status(400).send("webhook_signature_invalid");
  }

  handleStripeEvent(event)
    .then(() => res.json({ received: true }))
    .catch((e) => {
      console.error("❌ webhook handler error:", e);
      res.status(500).send("webhook_handler_error");
    });
}

// Stripe Dashboard endpoint uses /api/stripe/webhook
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);
// Alias (optional)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

/* ======================
   Middleware (CORS + JSON)
====================== */
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin), false);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "x-gle-user",
      "x-gle-account-id",
      "x-openai-key",
      "stripe-signature",
    ],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(express.json({ limit: "1mb" }));

/* ======================
   Routes
====================== */
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
app.get("/api/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    buildTag: BUILD_TAG,
<<<<<<< HEAD
    stripe: Boolean(stripe) && Boolean(STRIPE_PRICE_ID),
    stripeMode: STRIPE_MODE,
    stripePriceId: STRIPE_PRICE_ID || null,
    byokOnly: BYOK_ONLY,
    models: { byok: MODEL_BYOK, pro: MODEL_PRO, boost: MODEL_BOOST },
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
=======
    stripe: !!stripe,
    stripeMode,
    stripePriceId: STRIPE_PRICE_ID || "",
    byokOnly: BYOK_ONLY,
    models: {
      byok: MODEL_BYOK,
      pro: MODEL_PRO,
      boost: MODEL_BOOST,
    },
    limits: { free: LIMIT_FREE, pro: LIMIT_PRO },
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
    allowedOrigins: ALLOWED_ORIGINS,
    ts: Date.now(),
  });
});

<<<<<<< HEAD
// ✅ Frontend sendet nur x-gle-user -> wir mappen accountId automatisch
app.get("/api/me", (req, res) => {
  const userId = getUserId(req);
  let accountId = getAccountId(req);

  // Fallback: accountId = "acc_<userSuffix>"
  if (!accountId) accountId = `acc_${safeIdSuffix(userId) || Date.now()}`;

  const u = ensureUser(accountId);
  resetIfNeeded(u);
  saveDb();

  return res.json({
    ok: true,
    user_id: userId,
    accountId,
    plan: u.plan,
    usage: u.usage,
    stripe: u.stripe,
    byokOnly: BYOK_ONLY,
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    buildTag: BUILD_TAG,
    ts: Date.now(),
  });
});

// BYOK smoke test
app.get("/api/test", async (req, res) => {
  try {
    const byokKey = getByokKey(req);
    if (!byokKey) return res.status(400).json({ error: "Missing x-openai-key (BYOK)" });

    const { text, tokens } = await callOpenAI({
      apiKey: byokKey,
      model: MODEL_BYOK,
      input: "Sag genau: OK",
      maxOut: 50,
      reasoningEffort: null,
    });

    return res.json({
      ok: true,
      output: text || "OK",
      model: MODEL_BYOK,
      tokens: tokens || 0,
      pass: true,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "test_failed" });
  }
});

// Generate
app.post("/api/generate", async (req, res) => {
  try {
    const userId = getUserId(req);
    let accountId = getAccountId(req);
    if (!accountId) accountId = `acc_${safeIdSuffix(userId) || Date.now()}`;

    const u = ensureUser(accountId);
    resetIfNeeded(u);

    const plan = String(u.plan || "FREE").toUpperCase();
    const limit = computeLimit(plan);

    const byokKey = getByokKey(req);
    const isBYOK = !!byokKey;

    const wantsBoost = String(req.body?.boost || "false").toLowerCase() === "true";

    if (BYOK_ONLY && !isBYOK) {
      return res.status(402).json({ error: "BYOK_ONLY enabled", meta: { plan, isBYOK } });
    }

    if (!isBYOK) {
      if (plan !== "PRO") {
        return res.status(402).json({
          error: "PRO required (no BYOK key provided).",
          meta: { plan, isBYOK: false },
        });
      }
      if (!SERVER_OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Server OpenAI key missing (SERVER_OPENAI_API_KEY)",
        });
      }
    }

    if (u.usage.used >= limit) {
      return res.status(429).json({
        error: "quota_reached",
        plan,
        used: u.usage.used,
        limit,
        renewAt: u.usage.renewAt,
      });
    }

    const prompt = buildPromptFromFields(req.body);

    let modelToUse = isBYOK ? MODEL_BYOK : MODEL_PRO;
    let maxOut = DEFAULT_MAX_OUT;
    let reasoningEffort = null;

    if (wantsBoost) {
      modelToUse = MODEL_BOOST;
      maxOut = BOOST_MAX_OUT;
      reasoningEffort = REASONING_EFFORT;
    }

    const apiKeyToUse = isBYOK ? byokKey : SERVER_OPENAI_API_KEY;

    const { text, tokens, raw } = await callOpenAI({
      apiKey: apiKeyToUse,
      model: modelToUse,
      input: prompt,
      maxOut,
      reasoningEffort,
    });

    if (!text) {
      return res.status(500).json({ error: "no_text_from_openai" });
    }
=======
app.get("/api/me", (req, res) => {
  try {
    const db = readDB();
    const { user_id, accountId } = ensureIds(req);
    const user = ensureUser(db, accountId, user_id);

    const plan =
      String(user.plan || "FREE").toUpperCase() === "PRO" ? "PRO" : "FREE";

    writeDB(db);

    return res.json({
      ok: true,
      user_id,
      accountId,
      plan,
      usage: {
        used: Number(user.usage?.used || 0),
        renewAt: Number(user.usage?.renewAt || utcNextMonthFirstMs()),
        tokens: Number(user.usage?.tokens || 0),
        lastTs: Number(user.usage?.lastTs || 0),
      },
      stripe: {
        customerId: String(user.stripe?.customerId || ""),
        subscriptionId: String(user.stripe?.subscriptionId || ""),
        status: String(user.stripe?.status || ""),

        // NEW:
        cancelAtPeriodEnd: !!user.stripe?.cancelAtPeriodEnd,
        currentPeriodEnd:
          typeof user.stripe?.currentPeriodEnd === "number"
            ? user.stripe.currentPeriodEnd
            : null,
        lastInvoiceStatus: String(user.stripe?.lastInvoiceStatus || ""),
      },

      byokOnly: BYOK_ONLY,
      limits: { free: LIMIT_FREE, pro: LIMIT_PRO },
      buildTag: BUILD_TAG,
      ts: Date.now(),
    });
  } catch (e) {
    console.error("me error:", e);
    return res.status(500).json({ ok: false, error: "me_error" });
  }
});

app.use(express.json({ limit: "1mb" }));

/* ======================
   Routes
====================== */
app.get("/api/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    buildTag: BUILD_TAG,
    stripe: !!stripe,
    stripeMode,
    stripePriceId: STRIPE_PRICE_ID || "",
    byokOnly: BYOK_ONLY,
    models: {
      byok: MODEL_BYOK,
      pro: MODEL_PRO,
      boost: MODEL_BOOST,
    },
    limits: { free: LIMIT_FREE, pro: LIMIT_PRO },
    allowedOrigins: ALLOWED_ORIGINS,
    ts: Date.now(),
  });
});

app.get("/api/me", (req, res) => {
  try {
    const db = readDB();
    const { user_id, accountId } = ensureIds(req);
    const user = ensureUser(db, accountId, user_id);

    // ensure usage reset if needed is inside ensureUser
    const plan =
      String(user.plan || "FREE").toUpperCase() === "PRO" ? "PRO" : "FREE";

    writeDB(db);

    return res.json({
      ok: true,
      user_id,
      accountId,
      plan,
      usage: {
        used: Number(user.usage?.used || 0),
        renewAt: Number(user.usage?.renewAt || utcNextMonthFirstMs()),
        tokens: Number(user.usage?.tokens || 0),
        lastTs: Number(user.usage?.lastTs || 0),
      },
      stripe: {
        customerId: String(user.stripe?.customerId || ""),
        subscriptionId: String(user.stripe?.subscriptionId || ""),
        status: String(user.stripe?.status || ""),
        // NEW:
        cancelAtPeriodEnd: !!user.stripe?.cancelAtPeriodEnd,
        currentPeriodEnd: user.stripe?.currentPeriodEnd || null,
        lastInvoiceStatus: String(user.stripe?.lastInvoiceStatus || ""),
      },
      byokOnly: BYOK_ONLY,
      limits: { free: LIMIT_FREE, pro: LIMIT_PRO },
      buildTag: BUILD_TAG,
      ts: Date.now(),
    });
  } catch (e) {
    console.error("me error:", e);
    return res.status(500).json({ ok: false, error: "me_error" });
  }
});

app.post("/api/test", async (req, res) => {
  try {
    const key = String(req.headers["x-openai-key"] || "").trim();
    if (!key) return res.status(400).json({ error: "missing_openai_key" });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL_BYOK, input: "ping" }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(400).json({
        error: "invalid_key",
        message: data?.error?.message || "OpenAI test failed",
      });
    }
    return res.json({ ok: true, message: "OK" });
  } catch (e) {
    return res.status(500).json({ error: "test_error" });
  }
});

/* ======================
   Stripe: Create Checkout Session
====================== */
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "stripe_not_configured" });
    if (!STRIPE_PRICE_ID)
      return res.status(500).json({ error: "stripe_price_missing" });

    const db = readDB();
    const { user_id, accountId } = ensureIds(req);
    const user = ensureUser(db, accountId, user_id);

    // Ensure customer
    let customerId = String(user.stripe?.customerId || "").trim();
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { accountId, userId: user_id },
      });
      customerId = String(customer.id || "").trim();
      user.stripe.customerId = customerId;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/checkout-cancel`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      metadata: { accountId, userId: user_id },
      subscription_data: { metadata: { accountId, userId: user_id } },
    });

    user.updatedAt = Date.now();
    writeDB(db);

    return res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("stripe checkout error:", e);
    return res.status(500).json({ error: "stripe_checkout_error" });
  }
});

/* ======================
   Stripe: Sync Checkout Session (manual sync button)
====================== */
app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "stripe_not_configured" });

    const sessionId = String(
      req.body?.sessionId || req.body?.session_id || ""
    ).trim();
    if (!sessionId)
      return res.status(400).json({ error: "missing_session_id" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const metaAcc = String(session?.metadata?.accountId || "").trim();
    const metaUser = String(session?.metadata?.userId || "").trim();

    const fallback = ensureIds(req);
    const accountId = metaAcc || fallback.accountId;
    const user_id = metaUser || fallback.user_id;

    const db = readDB();
    const user = ensureUser(db, accountId, user_id);

    const paid =
      String(session?.payment_status || "").toLowerCase() === "paid" ||
      String(session?.status || "").toLowerCase() === "complete";

    if (!paid) {
      return res.status(402).json({
        error: "not_paid",
        message: `Session nicht bezahlt (status=${session?.status}, payment_status=${session?.payment_status})`,
      });
    }

    user.plan = "PRO";
    user.stripe.customerId = String(
      session?.customer || user.stripe.customerId || ""
    ).trim();
    user.stripe.subscriptionId = String(
      session?.subscription || user.stripe.subscriptionId || ""
    ).trim();
    user.stripe.status = "active";
    user.updatedAt = Date.now();

    writeDB(db);

    return res.json({
      ok: true,
      user_id,
      accountId,
      plan: "PRO",
      stripe: {
        customerId: user.stripe.customerId,
        subscriptionId: user.stripe.subscriptionId,
        status: user.stripe.status,
      },
      ts: Date.now(),
    });
  } catch (e) {
    console.error("sync checkout error:", e);
    return res.status(500).json({ error: "sync_error" });
  }
});

/* ======================
   Stripe: Billing Portal
====================== */
app.post("/api/billing-portal", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "stripe_not_configured" });

    // ======================
    // Stripe: Billing Portal (Abo verwalten / Rechnungen / Kündigung)
    // NEW FEATURES:
    // - STRICT: never auto-create accountId here (prevents "new domain => new FREE user")
    // - PRO-only gate
    // - return_url -> /billing-return (your own return page) + fallback to /?from=billing
    // - optional: accept ?return=billing|home from frontend (override)
    // ======================

    const accountId = getAccountId(req); // STRICT: must exist
    if (!accountId)
      return res.status(400).json({ error: "missing_account_id" });

    const user_id = getUserId(req) || "anon";

    // load user (existing account)
    const db = readDB();
    const user = ensureUser(db, accountId, user_id);

    const plan =
      String(user.plan || "FREE").toUpperCase() === "PRO" ? "PRO" : "FREE";
    if (plan !== "PRO") return res.status(403).json({ error: "not_pro" });

    const customerId = String(user?.stripe?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ error: "no_customer" });

    // Return URL handling (NEW):
    // default -> /billing-return (custom page with "← Zurück zu GLE Prompt Studio")
    // fallback -> /?from=billing (your home refresh logic)
    const base =
      String(STRIPE_BILLING_RETURN_URL || FRONTEND_URL || "")
        .trim()
        .replace(/\/$/, "") || "https://studio.getlaunchedge.com";

    const returnMode = String(
      req.query?.return || req.body?.return || ""
    ).trim(); // optional: "home"|"billing"
    const returnUrl =
      returnMode === "home"
        ? `${base}/?from=billing`
        : `${base}/billing-return`;

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    user.updatedAt = Date.now();
    writeDB(db);

    return res.json({ ok: true, url: portal.url, returnUrl });

    writeDB(db);

    return res.json({ ok: true, url: portal.url });
  } catch (e) {
    console.error("billing portal error:", e);
    return res.status(500).json({ error: "billing_portal_error" });
  }
});

/* ======================
   Generate (BYOK / PRO / Trial / Boost / Honeypot)
====================== */
app.post("/api/generate", async (req, res) => {
  try {
    // Honeypot
    const hp = String(req.body?.[HONEYPOT_FIELD] || "").trim();
    if (hp) return res.json({ ok: true, result: "", meta: { honeypot: true } });

    const db = readDB();
    const { user_id, accountId } = ensureIds(req);
    const user = ensureUser(db, accountId, user_id);

    const plan =
      String(user.plan || "FREE").toUpperCase() === "PRO" ? "PRO" : "FREE";
    const limit = limitsForPlan(plan);

    // usage limit check
    if (Number(user.usage.used || 0) >= limit) {
      return res.status(429).json({
        error: "quota_reached",
        message: `Limit erreicht (${user.usage.used}/${limit}).`,
      });
    }

    // Input
    const useCase = String(req.body?.useCase || "").trim() || "General";
    const tone = String(req.body?.tone || "").trim() || "Neutral";
    const language = String(req.body?.language || "").trim() || "Deutsch";
    const topic = String(req.body?.topic || "").trim();
    const extra = String(req.body?.extra || "").trim();
    const boost = !!req.body?.boost;

    if (!topic) return res.status(400).json({ error: "missing_topic" });

    // Key decision
    const byokKey = String(req.headers["x-openai-key"] || "").trim();

    let apiKey = "";
    let model = MODEL_BYOK;
    let usingServerKey = false;

    if (byokKey) {
      apiKey = byokKey;
      model = boost ? MODEL_BOOST : MODEL_BYOK;
      usingServerKey = false;
    } else {
      if (BYOK_ONLY) {
        return res.status(401).json({ error: "byok_required" });
      }
      if (!SERVER_OPENAI_API_KEY) {
        return res.status(500).json({ error: "server_key_missing" });
      }

      if (plan === "PRO") {
        apiKey = SERVER_OPENAI_API_KEY;
        model = boost ? MODEL_BOOST : MODEL_PRO;
        usingServerKey = true;
      } else {
        // FREE without BYOK => trial
        if (!TRIAL_ENABLED)
          return res.status(401).json({ error: "byok_required" });

        const c = consumeTrial(user);
        if (!c.ok) return res.status(402).json({ error: "trial_exhausted" });

        apiKey = SERVER_OPENAI_API_KEY;
        model = MODEL_PRO;
        usingServerKey = true;
      }
    }

    // Compose master prompt generation
    const system = `You are GLE Prompt Studio. Create a high-quality MASTER PROMPT the user can paste into an AI model.
Rules:
- Output ONLY the master prompt text.
- Include role, goal, constraints, step-by-step, output format, quality checks.
- Language: ${language}
- Tone: ${tone}
- Use case: ${useCase}`;

    const userMsg = `Topic/context:
${topic}

Extra notes:
${extra || "-"}

Quality Boost: ${boost ? "ON" : "OFF"}`;

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({
        error: "openai_error",
        message: data?.error?.message || "OpenAI request failed",
      });
    }

    const text = pickOutput(data);
    if (!text) return res.status(502).json({ error: "no_text_from_openai" });

    const tokens = extractTokens(data);

    // Persist usage
    user.usage.used = Number(user.usage.used || 0) + 1;
    user.usage.tokens = Number(user.usage.tokens || 0) + tokens;
    user.usage.lastTs = Date.now();
    user.updatedAt = Date.now();
    writeDB(db);
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)

    u.usage.used += 1;
    u.usage.tokens += Number(tokens || 0);
    u.usage.lastTs = Date.now();
    saveDb();

    return res.json({
      ok: true,
      result: text,
      meta: {
<<<<<<< HEAD
        model: raw?.model || modelToUse,
        tokens: Number(tokens || 0),
        boost: !!wantsBoost,
        plan,
        isBYOK,
        billedToServer: !isBYOK,
        accountId,
        buildTag: BUILD_TAG,
        requestId: raw?.id || null,
=======
        plan,
        model,
        isBYOK: !!byokKey,
        usingServerKey,
        tokens,
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
      },
      usage: {
        used: user.usage.used,
        renewAt: user.usage.renewAt,
        tokens: user.usage.tokens,
        lastTs: user.usage.lastTs,
      },
      limits: { free: LIMIT_FREE, pro: LIMIT_PRO },
    });
  } catch (e) {
    console.error("generate error:", e);
    return res.status(500).json({ error: "generate_error" });
  }
});

<<<<<<< HEAD
// ✅ Checkout Session (PRO) — KEIN Amazon Pay
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });
    if (!STRIPE_PRICE_ID) return res.status(500).json({ error: "stripe_price_missing" });

    const userId = getUserId(req);

    let accountId = getAccountId(req);
    if (!accountId) {
      accountId = `acc_${safeIdSuffix(userId) || Date.now()}`;
      console.warn("⚠️ Missing x-gle-account-id -> generated accountId:", accountId);
    }

    // ensure exists
    ensureUser(accountId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,

      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,

      metadata: { userId, accountId },
      client_reference_id: accountId,

      // ✅ PayPal bleibt drin
      // ✅ Amazon Pay ist raus (nicht enthalten)
      payment_method_types: ["card", "paypal"],
    });

    db.checkouts[session.id] = {
      userId,
      accountId,
      createdAt: Date.now(),
      url: session.url,
    };
    saveDb();

    return res.json({ url: session.url, id: session.id, accountId });
  } catch (err) {
    console.error("create-checkout-session FULL:", err);

    return res.status(500).json({
      error: "checkout_failed",
      message: err && err.message ? err.message : String(err),
      type: err && err.type,
      code: err && err.code,
      param: err && err.param,
      requestId: err && err.requestId,
      raw:
        err && err.raw
          ? { message: err.raw.message, type: err.raw.type, code: err.raw.code }
          : null,
    });
  }
});

// ✅ Nach Zahlung: Session holen -> Subscription checken -> PRO setzen
app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });

    let sessionId = String(req.body?.sessionId || "").trim();
    if (sessionId.includes("#")) sessionId = sessionId.split("#")[0].trim();
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "missing_or_invalid_sessionId" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // accountId aus metadata/checkouts/header fallback
    let accountId =
      String(session?.metadata?.accountId || "").trim() ||
      String(db?.checkouts?.[sessionId]?.accountId || "").trim() ||
      getAccountId(req);

    // letzter fallback: aus userId
    const userId =
      String(session?.metadata?.userId || "").trim() ||
      String(db?.checkouts?.[sessionId]?.userId || "").trim() ||
      getUserId(req);

    if (!accountId) accountId = `acc_${safeIdSuffix(userId) || Date.now()}`;

    const sessionStatus = String(session?.status || "").toLowerCase();
    const paymentStatus = String(session?.payment_status || "").toLowerCase();
    const completed = sessionStatus === "complete" || paymentStatus === "paid";

    const subId = toStripeId(session?.subscription);
    let cusId = toStripeId(session?.customer);

    if (!completed || !subId) {
      return res.status(409).json({
        error: "checkout_not_completed_or_missing_subscription",
        sessionId,
        sessionStatus: session?.status || null,
        paymentStatus: session?.payment_status || null,
        subscriptionId: subId,
        customerId: cusId,
      });
    }

    const sub = await stripe.subscriptions.retrieve(subId);
    const subStatus = String(sub?.status || "").toLowerCase();
    const active = isSubActive(subStatus);

    if (!cusId) cusId = toStripeId(sub?.customer);

    const u = ensureUser(accountId);
    u.plan = active ? "PRO" : "FREE";
    u.stripe = u.stripe || {};
    u.stripe.customerId = cusId || null;
    u.stripe.subscriptionId = subId || null;
    u.stripe.status = subStatus || null;
    u.updatedAt = Date.now();

    saveDb();

    return res.json({
      ok: true,
      userId,
      accountId,
      plan: u.plan,
      status: u.stripe.status,
      subscriptionId: u.stripe.subscriptionId,
      customerId: u.stripe.customerId,
      buildTag: BUILD_TAG,
    });
  } catch (e) {
    console.error("sync-checkout-session error:", e?.message || e);
    return res.status(500).json({ error: "sync_failed", message: e?.message || String(e) });
  }
});

// Billing Portal (optional)
app.post("/api/billing-portal", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });

    const userId = getUserId(req);
    let accountId = getAccountId(req);
    if (!accountId) accountId = `acc_${safeIdSuffix(userId) || Date.now()}`;

    const u = ensureUser(accountId);

    let customerId = toStripeId(u?.stripe?.customerId);
    const sessionId = String(req.body?.sessionId || "").trim();

    if (!customerId && sessionId.startsWith("cs_")) {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      customerId = toStripeId(s?.customer);
    }

    if (!customerId) return res.status(400).json({ error: "missing_customerId" });

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: FRONTEND_URL,
    });

    return res.json({ url: portal.url });
  } catch (e) {
    console.error("billing-portal error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "billing_portal_failed" });
  }
});

// Admin: Plan setzen (nur wenn ADMIN_TOKEN gesetzt)
app.post("/api/dev/set-plan", (req, res) => {
  try {
    if (!ADMIN_TOKEN) return res.status(404).json({ error: "not_found" });

    const token = String(req.headers["x-admin-token"] || "").trim();
    if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });

    const userId = String(req.body?.userId || getUserId(req) || "").trim() || "anon";
    let accountId = String(req.body?.accountId || "").trim();
    if (!accountId) accountId = `acc_${safeIdSuffix(userId) || Date.now()}`;

    const planRaw = String(req.body?.plan || "").toUpperCase().trim();
    const nextPlan = planRaw === "PRO" ? "PRO" : "FREE";

    const u = ensureUser(accountId);
    u.plan = nextPlan;
    u.updatedAt = Date.now();
    saveDb();

    return res.json({ ok: true, userId, accountId, plan: u.plan });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "dev_set_plan_failed" });
  }
});

/* ======================
   9) Start
====================== */
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   BUILD_TAG=${BUILD_TAG}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(`   Stripe=${!!stripe} Mode=${STRIPE_MODE} Price=${STRIPE_PRICE_ID ? "set" : "missing"}`);
  console.log(`   AllowedOrigins=${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`   DB_FILE=${DB_FILE}`);
=======
/* ======================
   Start
====================== */
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   buildTag=${BUILD_TAG || "-"}`);
  console.log(`   DB_FILE=${DB_FILE}`);
  console.log(
    `   Stripe=${!!stripe} mode=${stripeMode} price=${
      STRIPE_PRICE_ID ? "set" : "missing"
    }`
  );
  console.log(`   Webhook secret=${STRIPE_WEBHOOK_SECRET ? "set" : "missing"}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
>>>>>>> 0a0f82a (Stripe webhook + billing return fixes)
});
