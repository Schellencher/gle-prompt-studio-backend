// backend/server.js — GLE Prompt Studio Backend (CLEAN, COMPLETE)
//
// FREE (BYOK) + PRO (Server-Key) + BYOK_ONLY toggle
// Stripe Checkout (Subscription) + Sync Flow + Billing Portal
// Stripe Webhook (RAW verify) + stores cancelAtPeriodEnd/currentPeriodEnd/lastInvoiceStatus
// JSON DB (db.json) + CORS allowlist
// /api/health, /api/me, /api/generate, /api/create-checkout-session,
// /api/sync-checkout-session, /api/create-portal-session, /api/stripe-webhook
//
// Node 18+ (you are on Node 24)

"use strict";

require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

// ----------------------
// Fetch (Node 18+ has global fetch; fallback if needed)
// ----------------------
const _fetch =
  globalThis.fetch ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

const app = express();
app.disable("x-powered-by");

// ======================
// 1) Base Config
// ======================
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const BUILD_TAG = String(process.env.BUILD_TAG || "local").trim();
const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

// Models
const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o-mini").trim();
const MODEL_BOOST = String(process.env.MODEL_BOOST || "gpt-4o").trim(); // optional “boost”

// Limits (monthly)
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

// Trial (rolling 24h) for FREE when using server key (optional)
const TRIAL_PRO_CALLS_24H = Number(process.env.TRIAL_PRO_CALLS_24H || 3);

// Optional: quality boost budget per month (PRO)
const PRO_QUALITY_BOOSTS = Number(process.env.PRO_QUALITY_BOOSTS || 50);

// Admin (optional)
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

// ======================
// 2) Stripe Config + Init
// ======================
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

if (STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.startsWith("pk_")) {
  throw new Error(
    "STRIPE_SECRET_KEY is a publishable key (pk_). Backend needs a secret key (sk_/rk_)."
  );
}

// optional: mini debug ohne Leak
console.log("StripeKeyPrefix:", STRIPE_SECRET_KEY.slice(0, 7));
console.log("ServerFile:", __filename);
console.log("CWD:", process.cwd());

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

const STRIPE_BILLING_RETURN_URL = String(
  process.env.STRIPE_BILLING_RETURN_URL || "https://studio.getlaunchedge.com"
).trim();

function stripeModeFromKey(k) {
  const s = String(k || "").trim();
  if (!s) return "disabled";
  // robust: handles “..._test_...” formats too
  if (
    s.startsWith("sk_live_") ||
    s.startsWith("rk_live_") ||
    s.includes("_live_")
  )
    return "live";
  if (
    s.startsWith("sk_test_") ||
    s.startsWith("rk_test_") ||
    s.includes("_test_")
  )
    return "test";
  return "unknown";
}

const STRIPE_MODE = stripeModeFromKey(STRIPE_SECRET_KEY);
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" })
  : null;

// Server OpenAI Key for PRO (Server-Key)
const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""
).trim();

// ======================
// 3) Helpers
// ======================
function nowMs() {
  return Date.now();
}

function sha16(input) {
  return crypto
    .createHash("sha256")
    .update(String(input || ""))
    .digest("hex")
    .slice(0, 16);
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function normalizeHeader(req, name) {
  return String(req.headers[name] || "").trim();
}

function monthRenewAtMs(ts = Date.now()) {
  // next month 00:00:00 UTC (matches your live style like 1769904000000)
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const next = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  return next.getTime();
}

function getIds(req) {
  const userId =
    normalizeHeader(req, "x-gle-user") ||
    String(req.body?.userId || "").trim() ||
    "anon";

  let accountId =
    normalizeHeader(req, "x-gle-account-id") ||
    normalizeHeader(req, "x-gle-account") ||
    String(req.body?.accountId || "").trim();

  if (!accountId) {
    // deterministic fallback (stable for same userId)
    accountId = `acc_${sha16(userId)}`;
  }

  return { userId, accountId };
}

// Honeypot spam field (front-end hidden input)
function passHoneypot(req, res) {
  const hp = String(
    req.body?.website || req.body?.company || req.body?.url || ""
  ).trim();
  if (hp) {
    // Silent success to waste bot time
    res.status(200).json({ ok: true });
    return false;
  }
  return true;
}

function isProStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "trialing" || s === "past_due";
}

// ======================
// 4) JSON DB
// ======================
function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      ensureDirForFile(DB_FILE);
      fs.writeFileSync(
        DB_FILE,
        JSON.stringify({ accounts: {}, checkouts: {} }, null, 2),
        "utf8"
      );
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = safeJsonParse(raw || "{}", { accounts: {}, checkouts: {} });
    return {
      accounts: parsed.accounts || {},
      checkouts: parsed.checkouts || {},
    };
  } catch (e) {
    console.error("DB load error:", e);
    return { accounts: {}, checkouts: {} };
  }
}

function saveDb(db) {
  try {
    ensureDirForFile(DB_FILE);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("DB save error:", e);
  }
}

const db = loadDb();

function getOrCreateAccount(accountId, userId) {
  if (!db.accounts[accountId]) {
    db.accounts[accountId] = {
      accountId,
      userId,
      plan: "FREE",
      byokOnly: BYOK_ONLY,
      createdAt: nowMs(),
      updatedAt: nowMs(),

      usage: {
        used: 0,
        tokens: 0,
        lastTs: null,
        renewAt: monthRenewAtMs(),
        qualityBoostsUsed: 0,
      },

      trial: {
        proCalls: [], // timestamps (ms) rolling 24h
      },

      stripe: {
        customerId: null,
        subscriptionId: null,
        status: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null, // ms
        lastInvoiceStatus: null,
      },
    };
    saveDb(db);
  }

  const acc = db.accounts[accountId];

  // keep freshest ids
  if (userId && userId !== "anon") acc.userId = userId;
  acc.byokOnly = BYOK_ONLY;

  // monthly reset
  if (!acc.usage?.renewAt || nowMs() >= Number(acc.usage.renewAt)) {
    acc.usage = {
      used: 0,
      tokens: 0,
      lastTs: acc.usage?.lastTs || null,
      renewAt: monthRenewAtMs(),
      qualityBoostsUsed: 0,
    };
  }

  acc.updatedAt = nowMs();
  saveDb(db);

  return acc;
}

function effectivePlan(acc) {
  // Stripe wins (if known)
  if (isProStatus(acc?.stripe?.status)) return "PRO";
  // fallback to stored plan
  return String(acc?.plan || "FREE").toUpperCase() === "PRO" ? "PRO" : "FREE";
}

function trialRemaining(acc) {
  const cutoff = nowMs() - 24 * 60 * 60 * 1000;
  const arr = Array.isArray(acc?.trial?.proCalls) ? acc.trial.proCalls : [];
  const filtered = arr.filter((t) => Number(t) >= cutoff);
  acc.trial.proCalls = filtered;
  saveDb(db);
  return Math.max(0, TRIAL_PRO_CALLS_24H - filtered.length);
}

function consumeTrial(acc) {
  if (!acc.trial) acc.trial = { proCalls: [] };
  acc.trial.proCalls.push(nowMs());
  trialRemaining(acc);
}

// ======================
// 5) Middleware
// ======================
app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server requests without Origin
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

// Stripe webhook must be RAW (define BEFORE express.json)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!stripe || !STRIPE_WEBHOOK_SECRET)
        return res.status(200).send("stripe_disabled");

      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("stripe webhook verify error:", err?.message || err);
        return res.status(400).send("bad_signature");
      }

      await handleStripeEvent(event);
      return res.json({ received: true });
    } catch (e) {
      console.error("stripe webhook handler error:", e);
      return res.status(500).send("webhook_error");
    }
  }
);

// JSON for all other routes
app.use(express.json({ limit: "1mb" }));

// ======================
// 6) Stripe helpers / event handling
// ======================
function findAccountByCustomerId(customerId) {
  if (!customerId) return null;
  const cid = String(customerId);
  for (const aid of Object.keys(db.accounts)) {
    const a = db.accounts[aid];
    if (a?.stripe?.customerId && String(a.stripe.customerId) === cid) return a;
  }
  return null;
}

async function handleStripeEvent(event) {
  const type = event.type;
  const obj = event.data?.object;

  // 1) Checkout completed: map metadata accountId -> set PRO + store ids
  if (type === "checkout.session.completed") {
    const session = obj;
    const meta = session?.metadata || {};
    const accountId = String(
      meta.accountId || session.client_reference_id || ""
    ).trim();
    const userId = String(meta.userId || "anon").trim();

    if (accountId) {
      const acc = getOrCreateAccount(accountId, userId);
      acc.plan = "PRO";
      acc.stripe.customerId = session.customer
        ? String(session.customer)
        : acc.stripe.customerId;
      acc.stripe.subscriptionId = session.subscription
        ? String(session.subscription)
        : acc.stripe.subscriptionId;
      acc.stripe.status = acc.stripe.status || "active";
      acc.updatedAt = nowMs();
      saveDb(db);
    }
    return;
  }

  // 2) Subscription status updates
  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    const sub = obj;
    const customerId = sub.customer ? String(sub.customer) : null;
    const acc = findAccountByCustomerId(customerId);
    if (!acc) return;

    acc.stripe.subscriptionId = sub.id
      ? String(sub.id)
      : acc.stripe.subscriptionId;
    acc.stripe.status = String(sub.status || "").toLowerCase() || null;

    acc.stripe.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
    acc.stripe.currentPeriodEnd = sub.current_period_end
      ? Number(sub.current_period_end) * 1000
      : null;

    // Plan follows subscription
    acc.plan = isProStatus(acc.stripe.status) ? "PRO" : "FREE";

    acc.updatedAt = nowMs();
    saveDb(db);
    return;
  }

  // 3) Invoice updates
  if (type.startsWith("invoice.")) {
    const inv = obj;
    const customerId = inv.customer ? String(inv.customer) : null;
    const acc = findAccountByCustomerId(customerId);
    if (!acc) return;

    acc.stripe.lastInvoiceStatus = String(inv.status || "") || null;

    // keep latest subscription status if present on invoice
    if (inv.subscription) acc.stripe.subscriptionId = String(inv.subscription);

    acc.updatedAt = nowMs();
    saveDb(db);
    return;
  }
}

// ======================
// 7) OpenAI call
// ======================
async function callOpenAIChat({ apiKey, model, messages }) {
  const r = await _fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `OpenAI error (${r.status})`;
    throw new Error(msg);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("No text from OpenAI");

  const totalTokens = Number(data?.usage?.total_tokens || 0);
  return { text, totalTokens, raw: data };
}

function buildMessages(body) {
  if (Array.isArray(body?.messages) && body.messages.length)
    return body.messages;

  const sys =
    "You are GLE Prompt Studio. Produce high-quality, structured, actionable output.";
  const user = String(body?.prompt || body?.input || "").trim()
    ? String(body.prompt || body.input).trim()
    : [
        `Use case: ${body?.useCase || "-"}`,
        `Tone: ${body?.tone || "-"}`,
        `Language: ${body?.language || "-"}`,
        `Topic: ${body?.topic || "-"}`,
        body?.extra ? `Extra: ${body.extra}` : "",
      ]
        .filter(Boolean)
        .join("\n");

  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

// ======================
// 8) Routes
// ======================
app.get("/api/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    buildTag: BUILD_TAG,
    stripe: Boolean(stripe) && Boolean(STRIPE_PRICE_ID),
    stripeMode: STRIPE_MODE,
    stripePriceId: STRIPE_PRICE_ID || null,
    byokOnly: BYOK_ONLY,
    models: { byok: MODEL_BYOK, pro: MODEL_PRO, boost: MODEL_BOOST },
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    allowedOrigins: ALLOWED_ORIGINS,
    ts: nowMs(),
  });
});

// /api/me — matches your LIVE style, plus cancellation fields
app.get("/api/me", async (req, res) => {
  const { userId, accountId } = getIds(req);
  const acc = getOrCreateAccount(accountId, userId);

  // Optional: if we have subscriptionId, refresh cancellation info (safe)
  if (stripe && acc?.stripe?.subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(
        acc.stripe.subscriptionId,
        {
          expand: ["latest_invoice"],
        }
      );

      acc.stripe.status =
        String(sub.status || "").toLowerCase() || acc.stripe.status;
      acc.stripe.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
      acc.stripe.currentPeriodEnd = sub.current_period_end
        ? Number(sub.current_period_end) * 1000
        : acc.stripe.currentPeriodEnd;

      const li = sub.latest_invoice;
      if (li && typeof li === "object" && li.status) {
        acc.stripe.lastInvoiceStatus = String(li.status);
      }

      acc.plan = isProStatus(acc.stripe.status) ? "PRO" : "FREE";
      acc.updatedAt = nowMs();
      saveDb(db);
    } catch {
      // ignore (still return what we have)
    }
  }

  return res.json({
    ok: true,
    user_id: acc.userId,
    accountId: acc.accountId,
    plan: effectivePlan(acc),
    usage: {
      used: Number(acc.usage?.used || 0),
      renewAt: Number(acc.usage?.renewAt || monthRenewAtMs()),
      tokens: Number(acc.usage?.tokens || 0),
      lastTs: acc.usage?.lastTs || null,
      qualityBoostsUsed: Number(acc.usage?.qualityBoostsUsed || 0),
      qualityBoostsLimit: effectivePlan(acc) === "PRO" ? PRO_QUALITY_BOOSTS : 0,
    },
    stripe: {
      customerId: acc.stripe?.customerId || null,
      subscriptionId: acc.stripe?.subscriptionId || null,
      status: acc.stripe?.status || null,
      cancelAtPeriodEnd: !!acc.stripe?.cancelAtPeriodEnd,
      currentPeriodEnd: acc.stripe?.currentPeriodEnd || null, // ms
      lastInvoiceStatus: acc.stripe?.lastInvoiceStatus || null,
    },
    byokOnly: BYOK_ONLY,
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    trial: { proCallsRemaining24h: trialRemaining(acc) },
    buildTag: BUILD_TAG,
    ts: nowMs(),
  });
});

app.post("/api/generate", async (req, res) => {
  try {
    if (!passHoneypot(req, res)) return;

    const { userId, accountId } = getIds(req);
    const acc = getOrCreateAccount(accountId, userId);

    const plan = effectivePlan(acc);

    // Limits
    const used = Number(acc.usage?.used || 0);
    const limit = plan === "PRO" ? PRO_LIMIT : FREE_LIMIT;
    if (used >= limit) {
      return res.status(429).json({
        ok: false,
        error: "limit_reached",
        plan,
        used,
        limit,
        renewAt: acc.usage?.renewAt || monthRenewAtMs(),
      });
    }

    // Determine key/model
    const wantsBoost = !!req.body?.boost;
    const wantsQualityBoost = !!req.body?.qualityBoost; // optional: extra “quality boost”

    const byokKey =
      normalizeHeader(req, "x-gle-openai-key") ||
      normalizeHeader(req, "x-openai-key") ||
      String(req.body?.openaiKey || "").trim();

    let apiKeyToUse = null;
    let modelToUse = MODEL_BYOK;

    if (BYOK_ONLY) {
      if (!byokKey)
        return res.status(401).json({ ok: false, error: "missing_byok_key" });
      apiKeyToUse = byokKey;
      modelToUse = MODEL_BYOK;
    } else {
      if (plan === "PRO") {
        // PRO defaults to server key
        apiKeyToUse = SERVER_OPENAI_API_KEY || byokKey;
        if (!apiKeyToUse)
          return res
            .status(500)
            .json({ ok: false, error: "server_key_missing" });

        if (wantsQualityBoost) {
          const qUsed = Number(acc.usage?.qualityBoostsUsed || 0);
          if (qUsed >= PRO_QUALITY_BOOSTS) {
            return res.status(402).json({
              ok: false,
              error: "quality_boost_exhausted",
              plan: "PRO",
              used: qUsed,
              limit: PRO_QUALITY_BOOSTS,
              renewAt: acc.usage?.renewAt || monthRenewAtMs(),
            });
          }
          acc.usage.qualityBoostsUsed = qUsed + 1;
        }

        modelToUse = wantsBoost ? MODEL_BOOST : MODEL_PRO;
      } else {
        // FREE: BYOK default; server key only via trial if requested
        const wantsServer =
          !!req.body?.useProServer || wantsBoost || wantsQualityBoost;

        if (wantsServer) {
          if (!SERVER_OPENAI_API_KEY)
            return res
              .status(500)
              .json({ ok: false, error: "server_key_missing" });

          const remain = trialRemaining(acc);
          if (remain <= 0) {
            return res.status(402).json({
              ok: false,
              error: "trial_exhausted",
              plan: "FREE",
              trialRemaining24h: 0,
            });
          }

          consumeTrial(acc);
          apiKeyToUse = SERVER_OPENAI_API_KEY;
          modelToUse = wantsBoost ? MODEL_BOOST : MODEL_PRO;
        } else {
          if (!byokKey)
            return res
              .status(401)
              .json({ ok: false, error: "missing_byok_key" });
          apiKeyToUse = byokKey;
          modelToUse = MODEL_BYOK;
        }
      }
    }

    const messages = buildMessages(req.body || {});
    const out = await callOpenAIChat({
      apiKey: apiKeyToUse,
      model: modelToUse,
      messages,
    });

    // usage
    acc.usage.used = used + 1;
    acc.usage.tokens =
      Number(acc.usage.tokens || 0) + Number(out.totalTokens || 0);
    acc.usage.lastTs = nowMs();
    acc.updatedAt = nowMs();
    saveDb(db);

    return res.json({
      ok: true,
      plan: effectivePlan(acc),
      model: modelToUse,
      output: out.text,
      usage: acc.usage,
      trial: { proCallsRemaining24h: trialRemaining(acc) },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "generate_failed",
      message: e?.message || String(e),
    });
  }
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });
    if (!STRIPE_PRICE_ID)
      return res.status(500).json({ ok: false, error: "stripe_price_missing" });

    const { userId, accountId } = getIds(req);
    const acc = getOrCreateAccount(accountId, userId);

    const customerEmail = String(req.body?.email || "").trim() || undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,

      // optional, aber gut:
      allow_promotion_codes: true,
      client_reference_id: accountId,
      metadata: { accountId, userId },
    });

    db.checkouts[session.id] = {
      accountId: acc.accountId,
      userId: acc.userId,
      createdAt: nowMs(),
    };
    saveDb(db);

    return res.json({ ok: true, url: session.url, id: session.id });
  } catch (e) {
    console.error("stripe checkout error:", e);
    return res.status(500).json({
      ok: false,
      error: "stripe_checkout_failed",
      message: e?.message || String(e),
    });
  }
});

app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });

    const accountId =
      normalizeHeader(req, "x-gle-account-id") ||
      String(req.body?.accountId || "").trim();

    const userId =
      normalizeHeader(req, "x-gle-user") ||
      String(req.body?.userId || "anon").trim();

    const sessionId = String(
      req.body?.sessionId || req.body?.session_id || req.query?.session_id || ""
    ).trim();

    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_accountId" });
    if (!sessionId)
      return res.status(400).json({ ok: false, error: "missing_sessionId" });

    const acc = getOrCreateAccount(accountId, userId);

    // 1) Session aus Stripe holen
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer", "subscription"],
    });

    // 2) Bezahlt?
    const paid =
      session.payment_status === "paid" ||
      session.status === "complete" ||
      session.payment_status === "no_payment_required";

    // 3) Customer + Subscription IDs übernehmen
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id;

    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;

    if (customerId) acc.stripe.customerId = customerId;
    if (subscriptionId) acc.stripe.subscriptionId = subscriptionId;

    // 4) Subscription Status + Kündigungsdaten holen (wenn vorhanden)
    if (acc.stripe.subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(
          acc.stripe.subscriptionId
        );
        acc.stripe.status = String(sub.status || "").toLowerCase();
        acc.stripe.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
        acc.stripe.currentPeriodEnd = sub.current_period_end
          ? Number(sub.current_period_end) * 1000
          : null;
      } catch (e) {
        // nicht fatal – paid reicht für PRO
      }
    }

    // 5) Plan setzen
    if (paid) {
      acc.plan = "PRO";
      if (!acc.stripe.status) acc.stripe.status = "active";
    } else {
      acc.plan = "FREE";
    }

    acc.updatedAt = Date.now();
    saveDb(db);

    return res.json({
      ok: true,
      user_id: userId,
      accountId,
      plan: effectivePlan(acc),
      stripe: acc.stripe,
      paid,
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        mode: session.mode,
      },
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "sync_failed",
      message: e?.message || String(e),
    });
  }
});

app.post("/api/create-portal-session", async (req, res) => {
  try {
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });

    const { userId, accountId } = getIds(req);
    const acc = getOrCreateAccount(accountId, userId);

    if (!acc.stripe?.customerId) {
      return res.status(400).json({ ok: false, error: "missing_customer_id" });
    }

    const returnUrl = `${STRIPE_BILLING_RETURN_URL}/?from=billing`;

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
      message: e?.message || String(e),
    });
  }
});

// Admin helper: link an account to a known Stripe subscription/customer (for local debugging)
// Usage: POST /api/admin/link-stripe  with header x-admin-token: <ADMIN_TOKEN>
// Admin helper: link an account to a known Stripe subscription/customer (for local debugging)
app.post("/api/admin/link-stripe", async (req, res) => {
  try {
    const token =
      normalizeHeader(req, "x-admin-token") ||
      String(req.body?.token || "").trim();
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "unauthorized" });

    const accountId = String(req.body?.accountId || "").trim();
    const customerId = String(req.body?.customerId || "").trim();
    const subscriptionId = String(req.body?.subscriptionId || "").trim();
    const userId = String(req.body?.userId || "anon").trim();

    if (!accountId)
      return res.status(400).json({ ok: false, error: "missing_accountId" });

    const acc = getOrCreateAccount(accountId, userId);

    if (customerId) acc.stripe.customerId = customerId;
    if (subscriptionId) acc.stripe.subscriptionId = subscriptionId;

    // ✅ local sofort PRO markieren (für UI/Dev)
    acc.plan = "PRO";
    acc.stripe.status = acc.stripe.status || "active";

    let stripeFetchOk = false;
    let stripeFetchError = null;

    // Optional: refresh from Stripe (nice-to-have, aber darf NICHT abbrechen)
    if (stripe && acc.stripe.subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(
          acc.stripe.subscriptionId
        );
        acc.stripe.customerId = String(
          sub.customer || acc.stripe.customerId || ""
        );
        acc.stripe.status =
          String(sub.status || "").toLowerCase() || acc.stripe.status;
        acc.stripe.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
        acc.stripe.currentPeriodEnd = sub.current_period_end
          ? Number(sub.current_period_end) * 1000
          : null;
        acc.plan = isProStatus(acc.stripe.status) ? "PRO" : "FREE";
        stripeFetchOk = true;
      } catch (e) {
        stripeFetchError = e?.message || String(e);
        // ✅ NICHT abbrechen – local bleibt PRO
      }
    }

    acc.updatedAt = nowMs();
    saveDb(db);

    return res.json({
      ok: true,
      accountId: acc.accountId,
      plan: effectivePlan(acc),
      stripe: acc.stripe,
      stripeFetchOk,
      stripeFetchError,
    });

    acc.updatedAt = nowMs();
    saveDb(db);

    return res.json({
      ok: true,
      accountId: acc.accountId,
      plan: effectivePlan(acc),
      stripe: acc.stripe,
      stripeFetchOk,
      stripeFetchError,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "admin_failed",
      message: e?.message || String(e),
    });
  }
});

// ======================
// 9) Start
// ======================
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   BUILD_TAG=${BUILD_TAG}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(
    `   Stripe=${Boolean(stripe)} Mode=${STRIPE_MODE} Price=${
      STRIPE_PRICE_ID ? "set" : "missing"
    }`
  );
  console.log(`   AllowedOrigins=${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`   DB_FILE=${DB_FILE}`);
});
