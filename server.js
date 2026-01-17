"use strict";

/**
 * server.js — GLE Prompt Studio Backend (CLEAN + STABLE)
 * Features:
 * - BUILD_TAG + RENDER_META in /api/health + debug headers
 * - /api/_routes lists registered routes (prove what runs live)
 * - Stripe webhook RAW BEFORE express.json()
 * - Billing Portal has 2 routes: /api/create-portal-session + /api/billing-portal (alias)
 * - CORS reads CORS_ORIGINS OR CORS_ORIGIN
 * - JSON DB uses DB_FILE (Render env) or ./data/db.json
 */

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({ override: true });
}

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// ----------------------
// Config / ENV
// ----------------------
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const STRIPE_BILLING_RETURN_URL = String(
  process.env.STRIPE_BILLING_RETURN_URL || FRONTEND_URL
).trim();

// Build tag: explicit -> Render commit -> local
const BUILD_TAG = String(
  process.env.BUILD_TAG || process.env.RENDER_GIT_COMMIT || "local"
).trim();

const RENDER_META = {
  gitCommit: process.env.RENDER_GIT_COMMIT || null,
  serviceId: process.env.RENDER_SERVICE_ID || null,
  serviceName: process.env.RENDER_SERVICE_NAME || null,
  instanceId: process.env.RENDER_INSTANCE_ID || null,
};

// Plans / Models
const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o-mini").trim();

const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""
).trim();

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

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

function stripeModeFromKey(k) {
  const s = String(k || "").trim();
  if (!s) return "disabled";
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

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const STRIPE_MODE = stripeModeFromKey(STRIPE_SECRET_KEY);

// CORS Origins (supports your Render env "CORS_ORIGIN")
function parseOrigins() {
  const env = String(
    process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || ""
  ).trim();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
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

// ----------------------
// JSON DB (DB_FILE or ./data/db.json)
// ----------------------
const DB_FILE = String(process.env.DB_FILE || "").trim();
const DEFAULT_DB_FILE = path.join(__dirname, "data", "db.json");
const DB_PATH = DB_FILE || DEFAULT_DB_FILE;

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ accounts: {} }, null, 2),
      "utf8"
    );
  }
}
ensureDbFile();

let DB = { accounts: {} };

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    DB = JSON.parse(raw || "{}");
    if (!DB.accounts) DB.accounts = {};
  } catch {
    DB = { accounts: {} };
  }
}
function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), "utf8");
  } catch (e) {
    console.error("DB save failed:", e);
  }
}
loadDb();

function nowMonthKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getIds(req) {
  const userId =
    String(req.headers["x-gle-user"] || req.body?.userId || "anon").trim() ||
    "anon";

  const accountId =
    String(
      req.headers["x-gle-account-id"] ||
        req.body?.accountId ||
        req.headers["x-gle-account"] ||
        ""
    ).trim() || "acc_" + crypto.randomBytes(10).toString("hex");

  return { userId, accountId };
}

function getOrCreateAccount(accountId, userId) {
  DB.accounts = DB.accounts || {};
  if (!DB.accounts[accountId]) {
    DB.accounts[accountId] = {
      accountId,
      userId: userId || "anon",
      plan: "FREE",
      usage: { monthKey: nowMonthKey(), count: 0 },
      stripe: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveDb();
  }
  const acc = DB.accounts[accountId];
  acc.userId = acc.userId || userId || "anon";
  acc.updatedAt = new Date().toISOString();

  const mk = nowMonthKey();
  if (!acc.usage) acc.usage = { monthKey: mk, count: 0 };
  if (acc.usage.monthKey !== mk) acc.usage = { monthKey: mk, count: 0 };

  return acc;
}

function findAccountIdByCustomerId(customerId) {
  try {
    for (const [aid, acc] of Object.entries(DB.accounts || {})) {
      if (acc?.stripe?.customerId === customerId) return aid;
    }
  } catch {}
  return null;
}

// ----------------------
// Debug headers (prove which deploy is live)
// ----------------------
app.use((req, res, next) => {
  res.setHeader("x-gle-build", BUILD_TAG);
  res.setHeader("x-gle-commit", RENDER_META.gitCommit || "n/a");
  res.setHeader("x-gle-service", RENDER_META.serviceName || "n/a");
  next();
});

// ----------------------
// Stripe Webhook RAW (MUST be before express.json())
// ----------------------
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!stripe) return res.status(500).send("stripe_not_configured");
      if (!STRIPE_WEBHOOK_SECRET)
        return res.status(500).send("missing_webhook_secret");

      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error(
          "❌ webhook signature verify failed:",
          err?.message || err
        );
        return res.status(400).send("bad_signature");
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const accountId =
          session?.metadata?.accountId || session?.client_reference_id;
        const userId = session?.metadata?.userId || "stripe";
        const customerId = session?.customer || null;

        if (accountId) {
          const acc = getOrCreateAccount(String(accountId), String(userId));
          acc.plan = "PRO";
          acc.stripe = acc.stripe || {};
          if (customerId) acc.stripe.customerId = customerId;
          saveDb();
          console.log("✅ webhook: checkout.session.completed -> PRO", {
            accountId,
          });
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const customerId = sub?.customer;
        if (customerId) {
          const accountId = findAccountIdByCustomerId(customerId);
          if (accountId) {
            const acc = getOrCreateAccount(accountId, "stripe");
            acc.plan = "FREE";
            saveDb();
            console.log("✅ webhook: subscription.deleted -> FREE", {
              accountId,
            });
          }
        }
      }

      return res.json({ received: true });
    } catch (e) {
      console.error("webhook error:", e);
      return res.status(500).send("webhook_failed");
    }
  }
);

// ----------------------
// CORS + JSON (after webhook)
// ----------------------
const corsMiddleware = cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
});

app.use(corsMiddleware);
app.options("*", corsMiddleware);
app.use(express.json({ limit: "1mb" }));

// ----------------------
// Health + Debug routes
// ----------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    build: BUILD_TAG,
    render: RENDER_META,
    stripe: {
      enabled: !!stripe,
      mode: STRIPE_MODE,
      priceSet: !!STRIPE_PRICE_ID,
    },
    corsOrigins: ALLOWED_ORIGINS,
  });
});

app.get("/api/_routes", (req, res) => {
  const out = [];
  const stack = app?._router?.stack || [];
  for (const layer of stack) {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods || {}).filter(Boolean);
      out.push({ path: layer.route.path, methods });
    }
  }
  res.json({ ok: true, count: out.length, routes: out });
});

app.get("/api/me", (req, res) => {
  const { userId, accountId } = getIds(req);
  const acc = getOrCreateAccount(accountId, userId);
  res.json({
    ok: true,
    accountId: acc.accountId,
    userId: acc.userId,
    plan: acc.plan,
    usage: acc.usage,
    limits: { FREE_LIMIT, PRO_LIMIT },
    stripe: { hasCustomerId: !!acc?.stripe?.customerId },
  });
});

// ----------------------
// Stripe: Checkout
// ----------------------
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });
    if (!STRIPE_PRICE_ID)
      return res.status(500).json({ ok: false, error: "missing_price_id" });

    const { userId, accountId } = getIds(req);
    const acc = getOrCreateAccount(accountId, userId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      client_reference_id: acc.accountId,
      metadata: { accountId: acc.accountId, userId: acc.userId },
    });

    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error("checkout error:", e);
    return res
      .status(500)
      .json({
        ok: false,
        error: "checkout_failed",
        message: e?.message || String(e),
      });
  }
});

// Optional sync if webhook is delayed/missed
app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });
    const sessionId = String(
      req.body?.sessionId || req.body?.session_id || ""
    ).trim();
    if (!sessionId)
      return res.status(400).json({ ok: false, error: "missing_session_id" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const accountId =
      session?.metadata?.accountId || session?.client_reference_id;
    const userId = session?.metadata?.userId || "stripe";
    const customerId = session?.customer || null;

    if (!accountId)
      return res
        .status(400)
        .json({ ok: false, error: "missing_account_id_in_session" });

    const acc = getOrCreateAccount(String(accountId), String(userId));
    acc.plan = "PRO";
    acc.stripe = acc.stripe || {};
    if (customerId) acc.stripe.customerId = customerId;
    saveDb();

    return res.json({
      ok: true,
      accountId: acc.accountId,
      plan: acc.plan,
      customerIdSet: !!acc.stripe.customerId,
    });
  } catch (e) {
    console.error("sync session error:", e);
    return res
      .status(500)
      .json({
        ok: false,
        error: "sync_failed",
        message: e?.message || String(e),
      });
  }
});

// ----------------------
// Stripe: Billing Portal (with alias)
// ----------------------
async function handlePortalSession(req, res) {
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

    const base = STRIPE_BILLING_RETURN_URL.replace(/\/$/, "");
    const returnUrl = `${base}/?from=billing`;

    const portal = await stripe.billingPortal.sessions.create({
      customer: acc.stripe.customerId,
      return_url: returnUrl,
    });

    return res.json({ ok: true, url: portal.url });
  } catch (e) {
    console.error("billing portal error:", e);
    return res
      .status(500)
      .json({
        ok: false,
        error: "portal_failed",
        message: e?.message || String(e),
      });
  }
}

// ✅ This is the 404 fix (alias must exist LIVE)
app.post("/api/create-portal-session", handlePortalSession);
app.post("/api/billing-portal", handlePortalSession); // Alias

// ----------------------
// OpenAI Generate (optional, safe fallback)
// ----------------------
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch"); // optional dependency
  } catch {
    fetchFn = null;
  }
}

function pickClientApiKey(req) {
  return String(
    req.headers["x-gle-openai-key"] ||
      req.headers["x-openai-key"] ||
      req.headers["authorization"] ||
      req.body?.apiKey ||
      ""
  )
    .replace(/^Bearer\s+/i, "")
    .trim();
}

app.post("/api/generate", async (req, res) => {
  try {
    const { userId, accountId } = getIds(req);
    const acc = getOrCreateAccount(accountId, userId);

    const plan = acc.plan === "PRO" ? "PRO" : "FREE";
    const limit = plan === "PRO" ? PRO_LIMIT : FREE_LIMIT;

    if (acc.usage.count >= limit) {
      return res.status(429).json({
        ok: false,
        error: "quota_reached",
        message: `Limit erreicht (${acc.usage.count}/${limit}).`,
        plan,
      });
    }

    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt)
      return res.status(400).json({ ok: false, error: "missing_prompt" });

    const clientKey = pickClientApiKey(req);
    const useServerKey = !BYOK_ONLY && plan === "PRO";
    const apiKey = useServerKey ? SERVER_OPENAI_API_KEY : clientKey;

    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "missing_api_key",
        message: useServerKey
          ? "SERVER_OPENAI_API_KEY fehlt (PRO)."
          : "Bitte eigenen OpenAI Key senden (BYOK).",
      });
    }

    if (!fetchFn) {
      return res.status(500).json({
        ok: false,
        error: "fetch_not_available",
        message:
          "fetch ist nicht verfügbar (Node < 18). Installiere node-fetch@2 oder setze Node 18+.",
      });
    }

    const model = useServerKey ? MODEL_PRO : MODEL_BYOK;

    const resp = await fetchFn("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: prompt,
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return res.status(502).json({
        ok: false,
        error: "openai_failed",
        status: resp.status,
        details: data,
      });
    }

    const text =
      (data.output_text && String(data.output_text)) ||
      (Array.isArray(data.output)
        ? data.output
            .flatMap((o) =>
              (o.content || []).map((c) => c.text).filter(Boolean)
            )
            .join("\n")
        : "") ||
      "";

    acc.usage.count += 1;
    saveDb();

    return res.json({ ok: true, plan, model, text });
  } catch (e) {
    console.error("generate error:", e);
    return res
      .status(500)
      .json({
        ok: false,
        error: "generate_failed",
        message: e?.message || String(e),
      });
  }
});

// ----------------------
// 404 fallback
// ----------------------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

// ----------------------
// Start
// ----------------------
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   BUILD_TAG=${BUILD_TAG}`);
  console.log(`   RENDER_COMMIT=${RENDER_META.gitCommit || "n/a"}`);
  console.log(
    `   Stripe=${!!stripe} mode=${STRIPE_MODE} priceSet=${!!STRIPE_PRICE_ID}`
  );
  console.log(`   DB_PATH=${DB_PATH}`);
  console.log(`   AllowedOrigins=${ALLOWED_ORIGINS.join(", ")}`);
  console.log(
    `✅ Portal routes registered: /api/create-portal-session + /api/billing-portal`
  );
});
