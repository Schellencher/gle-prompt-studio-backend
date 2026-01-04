// backend/server.js — GLE Prompt Studio Backend (STABLE, CORS + Stripe + BYOK + PRO + Webhook + JSON DB)
// Node >= 18 (Node 24 OK). Uses global fetch (no node-fetch needed).

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const Stripe = require("stripe");

const app = express();

/* =========================
   1) Config
========================= */

const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const CORS_ORIGIN = String(process.env.CORS_ORIGIN || "").trim();

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

// Server key for PRO (optional)
const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || ""
).trim();

// Stripe (optional)
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PRICE_ID = String(process.env.STRIPE_PRICE_ID || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

// Admin
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "dev-admin").trim();

// Models
const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o-mini").trim();
const MODEL_BOOST = String(process.env.MODEL_BOOST || "gpt-5").trim();

// Limits
const FREE_LIMIT_DEFAULT = Number(process.env.FREE_LIMIT_DEFAULT || 25);
const PRO_LIMIT_DEFAULT = Number(process.env.PRO_LIMIT_DEFAULT || 250);

// DB
const DB_FILE = path.join(__dirname, "gle_users.json");

/* =========================
   2) CORS (Render-safe, includes x-gle-account-id)
   MUST be BEFORE routes
========================= */

const allowedOrigins = Array.from(
  new Set(
    CORS_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .concat([
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ])
  )
);

const FALLBACK_ALLOW_HEADERS =
  "Content-Type,Authorization,x-gle-user,x-gle-account-id,x-gle-acc,x-openai-key,x-admin-token,stripe-signature";

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    // echo requested headers (robust, prevents future header issues)
    const reqHeaders = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      reqHeaders ? String(reqHeaders) : FALLBACK_ALLOW_HEADERS
    );

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* =========================
   3) Stripe Webhook RAW (must be BEFORE express.json)
========================= */

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Stripe webhook (RAW body)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!stripe) return res.status(500).send("stripe_not_configured");

      const sig = String(req.headers["stripe-signature"] || "");
      let event = null;

      if (STRIPE_WEBHOOK_SECRET) {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          STRIPE_WEBHOOK_SECRET
        );
      } else {
        // If no webhook secret configured, we accept raw JSON (DEV only).
        event = JSON.parse(req.body.toString("utf8"));
      }

      const type = String(event?.type || "");
      const obj = event?.data?.object || null;

      // helpers
      const db = readDB();
      const safeWrite = () => writeDB(db);

      if (type === "checkout.session.completed") {
        const session = obj;

        const accountId = String(
          session?.metadata?.accountId || session?.client_reference_id || ""
        ).trim();

        const userId = String(session?.metadata?.userId || "").trim();

        if (accountId) {
          const u = ensureUser(db, accountId);
          u.plan = "PRO";
          u.stripe = u.stripe || {};
          u.stripe.customerId = String(session?.customer || "") || null;
          u.stripe.subscriptionId = String(session?.subscription || "") || null;
          u.stripe.status = "active";

          // keep last userId just for debug (optional)
          u.lastUserId = userId || u.lastUserId || null;

          safeWrite();
        }

        return res.json({ received: true });
      }

      // keep subscription status in sync (optional but good)
      if (
        type === "customer.subscription.created" ||
        type === "customer.subscription.updated" ||
        type === "customer.subscription.deleted"
      ) {
        const sub = obj;
        const status = String(sub?.status || "").toLowerCase();
        const okStatus = ["active", "trialing", "past_due"].includes(status);

        const accountId = String(sub?.metadata?.accountId || "").trim();
        if (accountId) {
          const u = ensureUser(db, accountId);
          u.stripe = u.stripe || {};
          u.stripe.customerId = String(sub?.customer || "") || null;
          u.stripe.subscriptionId = String(sub?.id || "") || null;
          u.stripe.status = status || null;

          u.plan = okStatus ? "PRO" : "FREE";
          safeWrite();
        }

        return res.json({ received: true });
      }

      return res.json({ received: true });
    } catch (e) {
      console.error("stripe-webhook error:", e?.message || e);
      return res.status(400).send(`webhook_error`);
    }
  }
);

/* =========================
   4) JSON body parser for all other routes
========================= */

app.use(express.json({ limit: "1mb" }));

/* =========================
   5) Helpers
========================= */

function nextMonthFirstDayTs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return { users: {}, version: 1 };
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const data = safeJsonParse(raw);
    if (!data || typeof data !== "object") return { users: {}, version: 1 };
    if (!data.users || typeof data.users !== "object") data.users = {};
    if (!data.version) data.version = 1;
    return data;
  } catch (e) {
    console.error("readDB error:", e?.message || e);
    return { users: {}, version: 1 };
  }
}

function writeDB(db) {
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error("writeDB error:", e?.message || e);
  }
}

function ensureUser(db, key) {
  if (!db.users[key]) {
    db.users[key] = {
      plan: "FREE",
      usage: { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 },
      stripe: { customerId: null, subscriptionId: null, status: null },
      createdAt: Date.now(),
      lastUserId: null,
    };
  }

  // renew usage monthly
  const u = db.users[key];
  if (!u.usage)
    u.usage = { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 };

  if (!u.usage.renewAt || typeof u.usage.renewAt !== "number") {
    u.usage.renewAt = nextMonthFirstDayTs();
  }

  if (Date.now() >= u.usage.renewAt) {
    u.usage.used = 0;
    u.usage.tokens = 0;
    u.usage.lastTs = 0;
    u.usage.renewAt = nextMonthFirstDayTs();
  }

  if (!u.stripe)
    u.stripe = { customerId: null, subscriptionId: null, status: null };
  if (!u.plan) u.plan = "FREE";
  return u;
}

function getHeader(req, name) {
  const v = req.headers[String(name).toLowerCase()];
  return Array.isArray(v) ? v[0] : String(v || "").trim();
}

function getUserId(req) {
  const h = getHeader(req, "x-gle-user");
  return h || "";
}

function getAccountId(req) {
  const a1 = getHeader(req, "x-gle-account-id");
  const a2 = getHeader(req, "x-gle-acc");
  const a3 = String(req.body?.accountId || "").trim();
  return String(a1 || a2 || a3 || "").trim();
}

// single identity key: accountId if available, else userId (fallback)
function identityKey(req) {
  const acc = getAccountId(req);
  if (acc) return acc;
  const uid = getUserId(req);
  return uid || "";
}

function isAdmin(req) {
  const token = getHeader(req, "x-admin-token");
  return token && token === ADMIN_TOKEN;
}

function pickOutput(data) {
  // chat.completions style
  const c1 = data?.choices?.[0]?.message?.content;
  if (typeof c1 === "string" && c1.trim()) return c1.trim();

  // fallback common fields
  const maybe =
    data?.result ||
    data?.output ||
    data?.text ||
    data?.output_text ||
    data?.message ||
    "";
  return String(maybe || "").trim();
}

async function openAIChat({ apiKey, model, messages }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      // no temperature set (prevents model errors)
    }),
  });

  const data = await r.json().catch(() => null);

  if (!r.ok) {
    const msg =
      data?.error?.message || data?.message || `OpenAI error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* =========================
   6) Routes
========================= */

// Health
app.get("/api/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    stripe: Boolean(stripe),
    byokOnly: BYOK_ONLY,
    models: { byok: MODEL_BYOK, pro: MODEL_PRO, boost: MODEL_BOOST },
    limits: { free: FREE_LIMIT_DEFAULT, pro: PRO_LIMIT_DEFAULT },
    allowedOrigins,
    ts: Date.now(),
  });
});

// Me (account status)
app.get("/api/me", (req, res) => {
  const key = identityKey(req);
  if (!key)
    return res.status(400).json({ ok: false, error: "Missing identity key" });

  const db = readDB();
  const u = ensureUser(db, key);
  writeDB(db);

  return res.json({
    ok: true,
    key,
    plan: u.plan,
    usage: u.usage,
    stripe: u.stripe || { status: null },
    byokOnly: BYOK_ONLY,
    limits: { free: FREE_LIMIT_DEFAULT, pro: PRO_LIMIT_DEFAULT },
    ts: Date.now(),
  });
});

// Test BYOK key
app.get("/api/test", async (req, res) => {
  try {
    const apiKey = getHeader(req, "x-openai-key");
    if (!apiKey)
      return res.status(400).json({ ok: false, error: "Missing x-openai-key" });

    const data = await openAIChat({
      apiKey,
      model: MODEL_BYOK,
      messages: [
        { role: "system", content: "Reply with exactly: OK" },
        { role: "user", content: "ping" },
      ],
    });

    const out = pickOutput(data);
    return res.json({ ok: true, output: out || "OK", model: MODEL_BYOK });
  } catch (e) {
    console.error("test error:", e?.message || e);
    return res
      .status(400)
      .json({ ok: false, error: e?.message || "test_failed" });
  }
});

// Generate
app.post("/api/generate", async (req, res) => {
  try {
    const key = identityKey(req);
    if (!key) return res.status(400).json({ error: "Missing identity key" });

    const userId = getUserId(req) || null;
    const apiKeyBYOK = getHeader(req, "x-openai-key");

    const { useCase, tone, language, topic, extra, boost } = req.body || {};
    const topicText = String(topic || "").trim();
    if (!topicText) return res.status(400).json({ error: "Missing topic" });

    const db = readDB();
    const u = ensureUser(db, key);

    // Determine plan (server truth)
    const plan = u.plan === "PRO" ? "PRO" : "FREE";

    const wantsBoost = Boolean(boost);
    const isBYOK = Boolean(apiKeyBYOK && apiKeyBYOK.trim());

    // BYOK-only mode
    if (BYOK_ONLY && !isBYOK) {
      return res.status(401).json({
        error: "BYOK-only: Missing x-openai-key",
        meta: { plan, isBYOK: false },
      });
    }

    // Choose which key/model to use
    let apiKey = "";
    let model = MODEL_BYOK;
    let billedToServer = false;

    if (isBYOK) {
      apiKey = apiKeyBYOK.trim();
      model = MODEL_BYOK;
      billedToServer = false;
    } else {
      // Server-credit call requires PRO + server key available
      if (plan !== "PRO") {
        return res.status(402).json({
          error: "PRO required (no BYOK key provided).",
          meta: { plan, isBYOK: false },
        });
      }
      if (!SERVER_OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Server OpenAI key missing (SERVER_OPENAI_API_KEY)",
          meta: { plan, isBYOK: false },
        });
      }
      apiKey = SERVER_OPENAI_API_KEY;
      model = wantsBoost ? MODEL_BOOST : MODEL_PRO;
      billedToServer = true;
    }

    // Enforce quota only for server-credit calls
    const limit = plan === "PRO" ? PRO_LIMIT_DEFAULT : FREE_LIMIT_DEFAULT;
    if (billedToServer && u.usage.used >= limit) {
      return res.status(429).json({
        error: `Limit reached (${u.usage.used}/${limit}).`,
        meta: { plan, isBYOK, limit, used: u.usage.used },
      });
    }

    const sys = [
      "You create a high-quality MASTER PROMPT for another AI model.",
      "Return ONLY the prompt text (no explanations).",
      "Make it structured, precise, and copy-paste ready.",
    ].join(" ");

    const userPrompt = [
      `Use case: ${String(useCase || "General")}`,
      `Tone: ${String(tone || "Neutral")}`,
      `Language: ${String(language || "Deutsch")}`,
      `Topic/Context: ${topicText}`,
      extra ? `Extra: ${String(extra)}` : "",
      wantsBoost ? "Quality: MAX (boost)" : "Quality: High",
    ]
      .filter(Boolean)
      .join("\n");

    const data = await openAIChat({
      apiKey,
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
    });

    const output = pickOutput(data);
    if (!output) return res.status(500).json({ error: "No text from OpenAI" });

    // Update usage only for server-credit calls
    let tokens = 0;
    try {
      tokens = Number(data?.usage?.total_tokens || 0) || 0;
    } catch {}

    if (billedToServer) {
      u.usage.used += 1;
      u.usage.tokens = Number(u.usage.tokens || 0) + tokens;
      u.usage.lastTs = Date.now();
      writeDB(db);
    } else {
      // still persist lastUserId optionally
      if (userId) {
        u.lastUserId = userId;
        writeDB(db);
      }
    }

    return res.json({
      ok: true,
      result: output,
      meta: {
        model,
        tokens: tokens || undefined,
        boost: wantsBoost,
        plan,
        isBYOK,
        billedToServer,
        requestId: String(data?.id || ""),
      },
    });
  } catch (e) {
    console.error("generate error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "generate_failed" });
  }
});

// ======================
// Checkout: create session (subscription)
// ======================
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

    const accountId = getAccountId(req);
    if (!accountId)
      return res.status(400).json({ error: "Missing x-gle-account-id" });

    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });
    if (!STRIPE_PRICE_ID)
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID" });

    const db = readDB();
    const u = ensureUser(db, accountId);
    u.stripe = u.stripe || {};
    writeDB(db);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,

      client_reference_id: accountId,
      metadata: { app: "gle", accountId, userId },
      subscription_data: { metadata: { app: "gle", accountId, userId } },

      success_url: `${FRONTEND_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/`,
    });

    return res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error("create-checkout-session error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "checkout_failed" });
  }
});

// ======================
// Sync after Checkout Success
// body: { sessionId: "cs_..." }
// ======================
app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "Missing/invalid sessionId" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    const accountId = String(
      session?.client_reference_id || session?.metadata?.accountId || ""
    ).trim();

    if (!accountId) {
      return res.status(400).json({ error: "No accountId on session" });
    }

    const sub = session.subscription;
    const subId =
      typeof sub === "object" ? String(sub.id || "") : String(sub || "");
    const status =
      typeof sub === "object" ? String(sub.status || "").toLowerCase() : "";

    const okStatus = ["active", "trialing", "past_due"].includes(status);
    if (!okStatus) {
      return res.status(400).json({
        ok: false,
        error: "subscription_not_active",
        status,
        subscriptionId: subId || null,
      });
    }

    const db = readDB();
    const u = ensureUser(db, accountId);

    u.plan = "PRO";
    u.stripe = u.stripe || {};
    u.stripe.customerId = session.customer ? String(session.customer) : null;
    u.stripe.subscriptionId = subId || null;
    u.stripe.status = status || null;

    writeDB(db);

    return res.json({
      ok: true,
      accountId,
      plan: u.plan,
      status,
      subscriptionId: subId,
    });
  } catch (e) {
    console.error("sync-checkout-session error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "sync_failed" });
  }
});

// ======================
// Sync after Checkout Success (no webhook required)
// body: { sessionId: "cs_..." }
// ======================
app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId.startsWith("cs_"))
      return res.status(400).json({ error: "Missing/invalid sessionId" });

    // Expand subscription to read status
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    const accountId = String(
      session.client_reference_id || session.metadata?.accountId || ""
    ).trim();

    if (!accountId)
      return res.status(400).json({ error: "Missing accountId on session" });

    const sub = session.subscription;
    const subId = typeof sub === "object" ? sub.id : String(sub || "");
    const status =
      typeof sub === "object" ? String(sub.status || "").toLowerCase() : "";

    const okStatus = ["active", "trialing", "past_due"].includes(status);

    // update DB
    const db = readDB();
    const u = ensureUser(db, accountId);

    u.stripe = u.stripe || {};
    u.stripe.customerId = session.customer ? String(session.customer) : null;
    u.stripe.subscriptionId = subId || null;
    u.stripe.status = status || null;

    if (okStatus) u.plan = "PRO";

    writeDB(db);

    return res.json({
      ok: true,
      accountId,
      plan: u.plan,
      status,
      subscriptionId: subId,
    });
  } catch (e) {
    console.error("sync-checkout-session error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "sync_failed" });
  }
});

// ======================
// Billing Portal (Self-Serve)
// body: { sessionId: "cs_..." }
// ======================
app.post("/api/billing-portal", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "Missing/invalid sessionId" });
    }

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const customer = checkoutSession.customer;
    if (!customer) {
      return res.status(400).json({ error: "No customer on checkout session" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: String(customer),
      return_url: `${FRONTEND_URL}/`,
    });

    return res.json({ url: portalSession.url });
  } catch (e) {
    console.error("billing-portal error:", e?.message || e);
    return res.status(500).json({ error: "portal_failed" });
  }
});

// ======================
// DEV: set plan (local only)
// Header: x-admin-token
// body: { accountId?, plan: "FREE" | "PRO" }
// ======================
app.post("/api/dev/set-plan", (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });

    const accountId = String(
      req.body?.accountId || identityKey(req) || ""
    ).trim();
    if (!accountId) return res.status(400).json({ error: "missing accountId" });

    const planRaw = String(req.body?.plan || "")
      .toUpperCase()
      .trim();
    const nextPlan = planRaw === "PRO" ? "PRO" : "FREE";

    const db = readDB();
    const u = ensureUser(db, accountId);
    u.plan = nextPlan;
    writeDB(db);

    return res.json({ ok: true, accountId, plan: u.plan });
  } catch (e) {
    console.error("dev/set-plan error:", e?.message || e);
    return res.status(500).json({ error: "dev_failed" });
  }
});

// ======================
// Admin: link subscription manually (optional)
// Header: x-admin-token
// body: { accountId, subscriptionId }
// ======================
app.post("/api/admin/link-subscription", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });

    const accountId = String(req.body?.accountId || "").trim();
    const subscriptionId = String(req.body?.subscriptionId || "").trim();
    if (!accountId) return res.status(400).json({ error: "missing accountId" });
    if (!subscriptionId.startsWith("sub_")) {
      return res.status(400).json({ error: "missing/invalid subscriptionId" });
    }

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const status = String(sub?.status || "").toLowerCase();
    const okStatus = ["active", "trialing", "past_due"].includes(status);
    if (!okStatus)
      return res.status(400).json({ error: "subscription not active" });

    const db = readDB();
    const u = ensureUser(db, accountId);

    u.plan = "PRO";
    u.stripe = u.stripe || {};
    u.stripe.customerId = String(sub.customer || "") || null;
    u.stripe.subscriptionId = subscriptionId;
    u.stripe.status = status || null;

    writeDB(db);

    return res.json({
      ok: true,
      linked: true,
      accountId,
      subscriptionId,
      status,
    });
  } catch (e) {
    console.error("link-subscription error:", e?.message || e);
    return res.status(500).json({ error: "link_failed" });
  }
});

// Default
app.use((req, res) => {
  return res.status(404).json({ error: "not_found" });
});

/* =========================
   7) Start
========================= */

app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(
    `   Stripe=${Boolean(stripe)} Price=${STRIPE_PRICE_ID ? "set" : "missing"}`
  );
  console.log(
    `   CORS allowedOrigins=${allowedOrigins.join(", ") || "(none)"}`
  );
});
