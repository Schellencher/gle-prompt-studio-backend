// backend/server.js — GLE Prompt Studio Backend (STABLE FINAL)
// BYOK + PRO(Server-Key) + Quality Boost (GPT-5) + Stripe Checkout + Stripe Webhook (RAW safe)
// + JSON DB + Admin BI (basic) + Health + Me + Generate + Billing Portal

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

// ======================
// Config
// ======================
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const CORS_ORIGIN = String(
  process.env.CORS_ORIGIN || "http://localhost:3001"
).trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

// Models
const BYOK_MODEL = String(process.env.BYOK_MODEL || "gpt-4o-mini").trim();
const PRO_MODEL = String(process.env.PRO_MODEL || "gpt-4o-mini").trim();

// Boost (Quality)
const BOOST_MODEL = String(process.env.BOOST_MODEL || "gpt-5").trim();
const DEFAULT_MAX_OUT = Number(process.env.DEFAULT_MAX_OUT || 900);
const BOOST_MAX_OUT = Number(process.env.BOOST_MAX_OUT || 1600);

// Limits (nur wenn Server-Key genutzt wird)
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

// Admin
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "dev-admin").trim();

// BI Config (optional)
const PRO_PRICE_EUR = Number(process.env.PRO_PRICE_EUR || 19.99);
const EURO_PER_1K_TOKENS = Number(process.env.EURO_PER_1K_TOKENS || 0.02);
const BI_WINDOW_DAYS = Number(process.env.BI_WINDOW_DAYS || 30);
const BI_CHURN_RATE = Number(process.env.BI_CHURN_RATE || 0.15);

// OpenAI Keys
const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || ""
).trim();

// GPT-5 reasoning effort (minimal|low|medium|high)
const OPENAI_REASONING_EFFORT = String(
  process.env.OPENAI_REASONING_EFFORT || "minimal"
).trim();

// ======================
// Stripe
// ======================
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PRICE_ID = String(process.env.STRIPE_PRICE_ID || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// ======================
// App init
// ======================
const app = express();

// ======================
// Allowed Origins + CORS (single source of truth)
// ======================

// Komma-Liste aus .env unterstützen
const ENV_ORIGINS = String(CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = Array.from(
  new Set(
    [
      ...ENV_ORIGINS,
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ].filter(Boolean)
  )
);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/postman/stripe webhooks (kein Origin)
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "x-gle-user",
    "x-openai-key",
    "x-admin-token",
    "stripe-signature",
  ],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ======================
// Mini JSON DB (DEV)
// ======================
const DB_FILE = path.join(__dirname, "gle_users.json");

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = { users: {}, processedEvents: {}, payments: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf-8");
      return init;
    }
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object")
      return { users: {}, processedEvents: {}, payments: [] };
    if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
    if (!parsed.processedEvents || typeof parsed.processedEvents !== "object")
      parsed.processedEvents = {};
    if (!Array.isArray(parsed.payments)) parsed.payments = [];

    return parsed;
  } catch {
    return { users: {}, processedEvents: {}, payments: [] };
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
  } catch {}
}

function nextMonthFirstDayTs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function ensureUser(db, userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      plan: "FREE", // FREE | PRO
      usage: { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 },
      stripe: {
        customerId: null,
        subscriptionId: null,
        email: null,
        status: null,
        lastInvoiceId: null,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const u = db.users[userId];

  if (!u.usage)
    u.usage = { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 };
  if (typeof u.usage.used !== "number") u.usage.used = 0;
  if (typeof u.usage.renewAt !== "number")
    u.usage.renewAt = nextMonthFirstDayTs();
  if (typeof u.usage.tokens !== "number") u.usage.tokens = 0;
  if (typeof u.usage.lastTs !== "number") u.usage.lastTs = 0;

  if (!u.stripe) {
    u.stripe = {
      customerId: null,
      subscriptionId: null,
      email: null,
      status: null,
      lastInvoiceId: null,
    };
  }

  const now = Date.now();
  if (now >= u.usage.renewAt) {
    u.usage.used = 0;
    u.usage.renewAt = nextMonthFirstDayTs();
  }

  u.updatedAt = new Date().toISOString();
  return u;
}

// ======================
// Stripe helpers (Idempotenz + Payments)
// ======================
function wasEventProcessed(db, eventId) {
  return Boolean(db?.processedEvents && db.processedEvents[eventId]);
}

function markEventProcessed(db, eventId) {
  if (!db.processedEvents || typeof db.processedEvents !== "object")
    db.processedEvents = {};
  db.processedEvents[eventId] = Date.now();

  // kleine Garbage Collection
  const keys = Object.keys(db.processedEvents);
  if (keys.length > 5000) {
    keys
      .sort((a, b) => db.processedEvents[a] - db.processedEvents[b])
      .slice(0, 1000)
      .forEach((k) => delete db.processedEvents[k]);
  }
}

function pushPayment(db, p) {
  if (!Array.isArray(db.payments)) db.payments = [];
  db.payments.push(p);
  if (db.payments.length > 100000) db.payments = db.payments.slice(-50000);
}

function findUserIdByStripe(db, { subscriptionId, customerId }) {
  const users = db?.users || {};
  for (const [uid, u] of Object.entries(users)) {
    if (
      (subscriptionId && u?.stripe?.subscriptionId === subscriptionId) ||
      (customerId && u?.stripe?.customerId === customerId)
    ) {
      return uid;
    }
  }
  return "";
}

// ======================
// Request helpers
// ======================
function getUserId(req) {
  // FIX: KEIN "anon" fallback -> sonst landen alle ohne Header im selben User
  return (req.headers["x-gle-user"] || "").toString().trim();
}

function getApiKeyFromRequest(req) {
  const hdr = req.headers["x-openai-key"];
  return typeof hdr === "string" && hdr.trim() ? hdr.trim() : "";
}

function getAdminToken(req) {
  const t = req.headers["x-admin-token"];
  return typeof t === "string" ? t.trim() : "";
}

// ======================
// OpenAI helpers
// ======================
function extractText(data) {
  // Responses API: output_text
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // Chat Completions: choices[0].message.content
  const c0 = data?.choices?.[0];
  const msg = c0?.message?.content;

  if (typeof msg === "string" && msg.trim()) return msg.trim();

  if (Array.isArray(msg)) {
    const t = msg
      .map((x) =>
        typeof x?.text === "string"
          ? x.text
          : typeof x?.content === "string"
          ? x.content
          : typeof x?.value === "string"
          ? x.value
          : ""
      )
      .join("")
      .trim();
    if (t) return t;
  }

  // Responses API: output[] -> content[] (prefer output_text parts)
  if (Array.isArray(data?.output)) {
    // 1) prefer explicit output_text items
    for (const o of data.output) {
      const parts = Array.isArray(o?.content) ? o.content : [];
      const p = parts.find(
        (x) => x?.type === "output_text" && typeof x?.text === "string"
      );
      if (p?.text?.trim()) return p.text.trim();
    }

    // 2) generic join
    const t = data.output
      .flatMap((o) => o?.content || [])
      .map((c) =>
        typeof c?.text === "string"
          ? c.text
          : typeof c?.content === "string"
          ? c.content
          : typeof c?.value === "string"
          ? c.value
          : ""
      )
      .join("")
      .trim();
    if (t) return t;
  }

  return "";
}

function extractTokenCount(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const t =
    Number(usage.total_tokens || 0) ||
    Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
  return Number.isFinite(t) ? t : 0;
}

function normalizeReasoningEffort(v) {
  const raw = String(v || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "none") return "minimal";
  if (raw === "xhigh") return "high";
  if (["minimal", "low", "medium", "high"].includes(raw)) return raw;
  return "minimal";
}

function makeId() {
  try {
    const crypto = require("crypto");
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return crypto.randomBytes(12).toString("hex");
  } catch {
    return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, { ...options, signal: controller.signal });

    const openaiRequestId =
      r.headers.get("x-request-id") ||
      r.headers.get("openai-request-id") ||
      r.headers.get("request-id") ||
      "";

    const data = await r.json().catch(() => ({}));
    return { r, data, openaiRequestId };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error("OpenAI timeout");
      err.status = 504;
      err.code = "OPENAI_TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAI({
  apiKey,
  model,
  system,
  userText,
  maxOutputTokens = 900,
  reasoningEffort = "minimal",
  timeoutMs = 60000,
}) {
  const isGpt5 = /^gpt-5/i.test(model);

  // ✅ GPT-5 -> Responses API (kein temperature setzen!)
  if (isGpt5) {
    const url = "https://api.openai.com/v1/responses";

    const body = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: userText }] },
      ],
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: normalizeReasoningEffort(reasoningEffort) },
    };

    const { r, data, openaiRequestId } = await fetchJsonWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeoutMs
    );

    if (!r.ok) {
      const msg =
        data?.error?.message || data?.message || `OpenAI error (${r.status})`;
      const err = new Error(msg);
      err.status = r.status;
      err.code = data?.error?.code || "OPENAI_ERROR";
      err.data = data;
      err.openaiRequestId = openaiRequestId;
      throw err;
    }

    return { data, text: extractText(data), openaiRequestId };
  }

  // ✅ Default -> Chat Completions
  const url = "https://api.openai.com/v1/chat/completions";

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    max_tokens: maxOutputTokens,
    temperature: 0.7,
  };

  const { r, data, openaiRequestId } = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!r.ok) {
    const msg =
      data?.error?.message || data?.message || `OpenAI error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.code = data?.error?.code || "OPENAI_ERROR";
    err.data = data;
    err.openaiRequestId = openaiRequestId;
    throw err;
  }

  return { data, text: extractText(data), openaiRequestId };
}

function buildSystemPrompt() {
  return `
Du bist "GLE Prompt Studio", ein Senior Prompt Engineer.
Du erzeugst EINEN hochwertigen Master-Prompt als Klartext.

Regeln:
- Liefere NUR den fertigen Master-Prompt (kein Drumherum, keine Erklärungen).
- Master-Prompt muss: Rolle, Kontext, Ziel, Inputs, Output-Format, Qualitätscheck enthalten.
- Sprache muss zur gewünschten Sprache passen.
- Tonalität muss zur gewünschten Tonalität passen.
- Der Prompt soll direkt 1:1 in ChatGPT/Claude/DeepSeek funktionieren.
`.trim();
}

// ======================
// Stripe Webhook (RAW) — MUSS vor express.json()
// ======================
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      if (!stripe) return res.status(500).send("Stripe not configured");
      if (!STRIPE_WEBHOOK_SECRET)
        return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      const db = loadDb();
      if (wasEventProcessed(db, event.id)) return res.json({ received: true });

      // Helper: set plan
      function setPlan(userId, plan, extraStripe = {}) {
        if (!userId) return;
        const u = ensureUser(db, userId);
        u.plan = plan;
        u.stripe = { ...(u.stripe || {}), ...extraStripe };
        u.updatedAt = new Date().toISOString();
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId = String(
          session?.metadata?.userId || session?.client_reference_id || ""
        ).trim();

        const customerId = session?.customer
          ? session.customer.toString()
          : null;
        const subscriptionId = session?.subscription
          ? session.subscription.toString()
          : null;

        setPlan(userId, "PRO", {
          customerId: customerId || null,
          subscriptionId: subscriptionId || null,
          status: "active",
          email: session?.customer_details?.email || null,
          lastInvoiceId: null,
        });

        pushPayment(db, {
          ts: Date.now(),
          userId,
          type: "checkout.session.completed",
          sessionId: session?.id || null,
          customerId,
          subscriptionId,
        });
      }

      if (event.type === "invoice.payment_succeeded") {
        const inv = event.data.object;
        const customerId = inv?.customer ? inv.customer.toString() : "";
        const subscriptionId = inv?.subscription
          ? inv.subscription.toString()
          : "";
        const userId = findUserIdByStripe(db, { subscriptionId, customerId });

        if (userId) {
          const u = ensureUser(db, userId);
          u.plan = "PRO";
          u.stripe.customerId = customerId || u.stripe.customerId;
          u.stripe.subscriptionId = subscriptionId || u.stripe.subscriptionId;
          u.stripe.status = "active";
          u.stripe.lastInvoiceId = inv?.id
            ? inv.id.toString()
            : u.stripe.lastInvoiceId;
          u.updatedAt = new Date().toISOString();

          pushPayment(db, {
            ts: Date.now(),
            userId,
            type: "invoice.payment_succeeded",
            invoiceId: inv?.id || null,
            customerId,
            subscriptionId,
          });
        }
      }

      if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;
        const customerId = sub?.customer ? sub.customer.toString() : "";
        const subscriptionId = sub?.id ? sub.id.toString() : "";
        const status = String(sub?.status || "").toLowerCase(); // active|trialing|past_due|canceled|...

        const userId = findUserIdByStripe(db, { subscriptionId, customerId });
        if (userId) {
          const isActive = status === "active" || status === "trialing";
          const u = ensureUser(db, userId);
          u.plan = isActive ? "PRO" : "FREE";
          u.stripe.customerId = customerId || u.stripe.customerId;
          u.stripe.subscriptionId = subscriptionId || u.stripe.subscriptionId;
          u.stripe.status = status || u.stripe.status;
          u.updatedAt = new Date().toISOString();
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const customerId = sub?.customer ? sub.customer.toString() : "";
        const subscriptionId = sub?.id ? sub.id.toString() : "";

        const userId = findUserIdByStripe(db, { subscriptionId, customerId });
        if (userId) {
          const u = ensureUser(db, userId);
          u.plan = "FREE";
          u.stripe.status = "canceled";
          u.updatedAt = new Date().toISOString();
        }
      }

      markEventProcessed(db, event.id);
      saveDb(db);

      return res.json({ received: true });
    } catch (err) {
      console.error("stripe-webhook error:", err?.message || err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

// ======================
// JSON Parser für alle anderen Routes
// ======================
app.use(express.json({ limit: "1mb" }));

// ======================
// Health
// ======================
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    stripe: Boolean(stripe && STRIPE_PRICE_ID),
    byokOnly: BYOK_ONLY,
    models: { byok: BYOK_MODEL, pro: PRO_MODEL, boost: BOOST_MODEL },
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    ts: Date.now(),
  });
});

// ======================
// Me (Plan + Usage) — Backend truth
// ======================
app.get("/api/me", (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId)
      return res.status(400).json({ ok: false, error: "Missing x-gle-user" });

    const db = loadDb();
    const u = ensureUser(db, userId);
    saveDb(db);

    return res.json({
      ok: true,
      userId,
      plan: u.plan, // "FREE" | "PRO"
      usage: {
        used: Number(u?.usage?.used || 0),
        renewAt: Number(u?.usage?.renewAt || nextMonthFirstDayTs()),
        tokens: Number(u?.usage?.tokens || 0),
        lastTs: Number(u?.usage?.lastTs || 0),
      },
      byokOnly: BYOK_ONLY,
      models: { byok: BYOK_MODEL, pro: PRO_MODEL, boost: BOOST_MODEL },
      limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
      ts: Date.now(),
    });
  } catch {
    return res.status(500).json({ ok: false, error: "me failed" });
  }
});

// ======================
// Test BYOK Key
// ======================
app.get("/api/test", async (req, res) => {
  try {
    const apiKey = getApiKeyFromRequest(req);
    if (!apiKey)
      return res.status(400).json({ ok: false, error: "Missing x-openai-key" });

    const { text, openaiRequestId } = await callOpenAI({
      apiKey,
      model: BYOK_MODEL,
      system: "Antworte mit genau einem Wort: OK",
      userText: "OK",
      maxOutputTokens: 16,
      reasoningEffort: OPENAI_REASONING_EFFORT,
      timeoutMs: 20000,
    });

    const out = String(text || "").trim();
    if (!out)
      return res.status(502).json({ ok: false, error: "No text from OpenAI" });

    return res.json({ ok: true, output: out, text: out, openaiRequestId });
  } catch (err) {
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "Key test failed",
      openaiRequestId: err?.openaiRequestId || "",
      code: err?.code || "",
    });
  }
});

// ======================
// Checkout: create session
// ======================
async function createCheckoutSession(req) {
  if (!stripe)
    throw Object.assign(new Error("Stripe not configured"), { status: 500 });
  if (!STRIPE_PRICE_ID)
    throw Object.assign(new Error("Missing STRIPE_PRICE_ID"), { status: 500 });

  const userId = getUserId(req);
  if (!userId)
    throw Object.assign(new Error("Missing x-gle-user"), { status: 400 });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: userId,
    metadata: { userId },
    allow_promotion_codes: true,
    success_url: `${FRONTEND_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}/`,
  });

  return session;
}

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const session = await createCheckoutSession(req);
    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("create-checkout-session error:", err?.message || err);
    return res
      .status(err?.status || 500)
      .json({ error: err?.message || "Checkout failed" });
  }
});

app.get("/api/create-checkout-session", async (req, res) => {
  try {
    const session = await createCheckoutSession(req);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("create-checkout-session error:", err?.message || err);
    return res
      .status(err?.status || 500)
      .send(err?.message || "Checkout failed");
  }
});

// ======================
// Billing Portal (Self-Serve)
// ======================
app.post("/api/billing-portal", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId.startsWith("cs_"))
      return res.status(400).json({ error: "Missing/invalid sessionId" });

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const customer = checkoutSession.customer;
    if (!customer)
      return res.status(400).json({ error: "No customer on session" });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.toString(),
      return_url: `${FRONTEND_URL}/checkout-success?from=portal`,
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    console.error("billing-portal error:", err?.message || err);
    return res
      .status(500)
      .json({ error: "Failed to create billing portal session" });
  }
});

// ======================
// Generate (GLE) + Boost
// ======================
app.post("/api/generate", async (req, res) => {
  const requestId = makeId();
  res.setHeader("x-gle-request-id", requestId);

  const exposeDebug =
    String(process.env.NODE_ENV || "")
      .toLowerCase()
      .trim() !== "production";

  try {
    const { useCase, tone, language, topic, extra } = req.body || {};
    const topicText = String(topic || "").trim();
    if (!topicText) return res.status(400).json({ error: "Missing topic" });

    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

    // Boost-Schalter
    const boost = Boolean(req.body?.boost || req.body?.qualityBoost);

    // Server-Truth
    const db = loadDb();
    const u = ensureUser(db, userId);
    const plan = String(u.plan || "FREE").toUpperCase(); // FREE | PRO

    // BYOK?
    const byokKey = getApiKeyFromRequest(req);
    const isBYOK = Boolean(byokKey);

    // Key + Model Auswahl: Server-Key NUR für PRO (außer BYOK_ONLY)
    let apiKey = "";
    let model = BYOK_MODEL;

    if (isBYOK) {
      apiKey = byokKey;
      model = BYOK_MODEL;
    } else {
      if (plan !== "PRO") {
        return res.status(402).json({
          error:
            "BYOK required on FREE. Please upgrade to PRO to use server credits.",
        });
      }
      if (BYOK_ONLY) {
        return res
          .status(402)
          .json({ error: "BYOK required (BYOK_ONLY=true)" });
      }
      apiKey = SERVER_OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({
          error: "SERVER_OPENAI_API_KEY missing (or send x-openai-key)",
        });
      }
      model = PRO_MODEL;
    }

    // Limits nur für Server-Key Calls
    if (!isBYOK) {
      const limit = plan === "PRO" ? PRO_LIMIT : FREE_LIMIT;
      if (u.usage.used >= limit) {
        return res.status(429).json({
          error: "PRO limit reached. Try again next month.",
        });
      }
    }

    // Boost: erlaubt für BYOK oder PRO(Server)
    let maxOut = DEFAULT_MAX_OUT;
    if (boost) {
      if (!isBYOK && plan !== "PRO") {
        return res
          .status(402)
          .json({ error: "PRO required for Quality Boost." });
      }
      model = BOOST_MODEL;
      maxOut = BOOST_MAX_OUT;
    }

    const system = buildSystemPrompt();
    const userText = [
      `Use Case: ${String(useCase || "").trim()}`,
      `Ton: ${String(tone || "").trim()}`,
      `Sprache: ${String(language || "").trim()}`,
      `Thema/Kontext: ${topicText}`,
      `Zusatz: ${String(extra || "").trim()}`,
    ].join("\n");

    const { data, text, openaiRequestId } = await callOpenAI({
      apiKey,
      model,
      system,
      userText,
      maxOutputTokens: maxOut,
      reasoningEffort: OPENAI_REASONING_EFFORT,
      timeoutMs: boost ? 90000 : 60000,
    });

    const out = String(text || "").trim();
    if (!out) {
      return res.status(502).json({
        error:
          "Keine Textausgabe erhalten (Backend konnte keinen Output extrahieren).",
        requestId,
        openaiRequestId,
        ...(exposeDebug
          ? {
              debug: {
                model,
                plan,
                isBYOK,
                keys: data ? Object.keys(data) : [],
                output_text_preview: String(data?.output_text || "").slice(
                  0,
                  400
                ),
                choices_preview: JSON.stringify(
                  data?.choices?.[0] || null
                ).slice(0, 600),
                output_preview: JSON.stringify(data?.output || null).slice(
                  0,
                  600
                ),
              },
            }
          : {}),
      });
    }

    // Usage track NUR Server-Key Calls
    const tokens = extractTokenCount(data?.usage);
    if (!isBYOK) {
      u.usage.used += 1;
      u.usage.tokens += tokens;
      u.usage.lastTs = Date.now();
    }
    saveDb(db);

    return res.json({
      output: out,
      result: out,
      meta: { model, tokens, boost, plan, isBYOK, requestId, openaiRequestId },
    });
  } catch (err) {
    console.error("generate error:", {
      requestId,
      status: err?.status || 500,
      code: err?.code,
      msg: err?.message,
      openaiRequestId: err?.openaiRequestId,
    });

    return res.status(err?.status || 500).json({
      error: err?.message || "Generate failed",
      requestId,
      openaiRequestId: err?.openaiRequestId || "",
      ...(exposeDebug
        ? { code: err?.code || "", status: err?.status || 500 }
        : {}),
    });
  }
});

// ======================
// Admin BI (basic)
// ======================
app.get("/api/admin/bi", (req, res) => {
  try {
    const token = getAdminToken(req);
    if (token !== ADMIN_TOKEN)
      return res.status(403).json({ error: "forbidden" });

    const db = loadDb();
    const users = Object.values(db.users || {});
    const totalUsers = users.length;
    const proUsers = users.filter((u) => u.plan === "PRO").length;

    const mrrEst = proUsers * PRO_PRICE_EUR;
    const churnEst = mrrEst * BI_CHURN_RATE;

    const totalTokens = users.reduce(
      (acc, u) => acc + Number(u?.usage?.tokens || 0),
      0
    );
    const tokenCostEst = (totalTokens / 1000) * EURO_PER_1K_TOKENS;

    return res.json({
      ok: true,
      totalUsers,
      proUsers,
      mrrEst,
      churnEst,
      tokenCostEst,
      paymentsCount: Array.isArray(db.payments) ? db.payments.length : 0,
      windowDays: BI_WINDOW_DAYS,
      ts: Date.now(),
    });
  } catch {
    return res.status(500).json({ error: "bi failed" });
  }
});

// ======================
// Start
// ======================
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(
    `   Models: BYOK=${BYOK_MODEL} | PRO=${PRO_MODEL} | BOOST=${BOOST_MODEL}`
  );
  console.log(`   Limits: FREE=${FREE_LIMIT} | PRO=${PRO_LIMIT}`);
  console.log(
    `   Stripe=${Boolean(stripe && STRIPE_PRICE_ID)} Price=${
      STRIPE_PRICE_ID ? "set" : "missing"
    }`
  );
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
});
