// backend/server.js — GLE Prompt Studio Backend (CLEAN, Render-safe)
// - Single CORS setup (no duplicate declarations)
// - Stripe Checkout (subscription) + Billing Portal
// - Stripe Webhook (raw safe) + idempotency
// - JSON DB: plan + usage
// Headers:
//   x-gle-user  (required) = usage identity
//   x-gle-acc   (optional) = stable account identity (Stripe mapping)
//   x-openai-key (optional) = BYOK key

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const fs = require("fs");
const path = require("path");

const app = express();

// ======================
// Config
// ======================
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();
// comma-list allowed: "http://localhost:3001,http://127.0.0.1:3001"
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || FRONTEND_URL).trim();

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || ""
).trim();

const MODELS = {
  byok: String(process.env.MODEL_BYOK || "gpt-4o-mini").trim(),
  pro: String(process.env.MODEL_PRO || "gpt-4o-mini").trim(),
  boost: String(process.env.MODEL_BOOST || "gpt-5").trim(),
};

const LIMITS = {
  free: Number(process.env.LIMIT_FREE || 25),
  pro: Number(process.env.LIMIT_PRO || 250),
};

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "dev-admin").trim();

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
// CORS (single source of truth)
// ======================
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

const corsOptions = {
  origin: (origin, cb) => {
    // allow curl/postman/stripe (no Origin header)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-gle-user",
    "x-gle-acc",
    "x-openai-key",
    "x-admin-token",
    "stripe-signature",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// simple request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ======================
// JSON DB (DEV)
// ======================
const DB_FILE = path.join(__dirname, "gle_users.json");

function nextMonthFirstDayMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = { users: {}, processedEvents: {}, payments: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf-8");
      return init;
    }
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const db = JSON.parse(raw || "{}");
    if (!db.users || typeof db.users !== "object") db.users = {};
    if (!db.processedEvents || typeof db.processedEvents !== "object")
      db.processedEvents = {};
    if (!Array.isArray(db.payments)) db.payments = [];
    return db;
  } catch (e) {
    return { users: {}, processedEvents: {}, payments: [] };
  }
}

function writeDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
  } catch (e) {
    console.error("DB write failed:", e?.message || e);
  }
}

function getHeader(req, name) {
  return String(req.headers[name] || "").trim();
}

function getUserId(req) {
  return getHeader(req, "x-gle-user");
}

function getAccountId(req) {
  return getHeader(req, "x-gle-acc");
}

function identityKey(req) {
  // prefer stable account id if present
  return getAccountId(req) || getUserId(req);
}

function ensureUser(db, key) {
  if (!db.users[key]) {
    db.users[key] = {
      plan: "FREE", // FREE | PRO
      usage: { used: 0, renewAt: nextMonthFirstDayMs(), tokens: 0, lastTs: 0 },
      stripe: {
        customerId: null,
        subscriptionId: null,
        status: null,
        email: null,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  const u = db.users[key];
  if (!u.usage)
    u.usage = { used: 0, renewAt: nextMonthFirstDayMs(), tokens: 0, lastTs: 0 };
  if (Date.now() >= Number(u.usage.renewAt || 0)) {
    u.usage.used = 0;
    u.usage.renewAt = nextMonthFirstDayMs();
  }
  u.updatedAt = Date.now();
  return u;
}

function wasEventProcessed(db, eventId) {
  return Boolean(db.processedEvents?.[eventId]);
}
function markEventProcessed(db, eventId) {
  db.processedEvents[eventId] = Date.now();
}

function addPayment(db, p) {
  db.payments.push(p);
  if (db.payments.length > 20000) db.payments = db.payments.slice(-10000);
}

function findKeyByStripe(db, { subscriptionId, customerId }) {
  const users = db.users || {};
  for (const [key, u] of Object.entries(users)) {
    if (
      (subscriptionId && u?.stripe?.subscriptionId === subscriptionId) ||
      (customerId && u?.stripe?.customerId === customerId)
    ) {
      return key;
    }
  }
  return "";
}

// ======================
// Stripe Webhook (RAW SAFE) — must be BEFORE express.json()
// ======================
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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

      const db = readDB();
      if (wasEventProcessed(db, event.id))
        return res.json({ received: true, deduped: true });

      const type = event.type;

      // ✅ Checkout completed -> activate PRO
      if (type === "checkout.session.completed") {
        const session = event.data.object;
        const accountId = String(
          session?.metadata?.accountId || session?.client_reference_id || ""
        ).trim();
        const customerId = session?.customer ? String(session.customer) : "";
        const subscriptionId = session?.subscription
          ? String(session.subscription)
          : "";
        const email =
          session?.customer_details?.email || session?.customer_email || null;

        if (accountId) {
          const u = ensureUser(db, accountId);
          u.plan = "PRO";
          u.stripe.customerId = customerId || u.stripe.customerId;
          u.stripe.subscriptionId = subscriptionId || u.stripe.subscriptionId;
          u.stripe.status = "active";
          u.stripe.email = email || u.stripe.email;
        }

        addPayment(db, {
          ts: Date.now(),
          type,
          accountId,
          customerId,
          subscriptionId,
          sessionId: session?.id || null,
        });
      }

      // ✅ recurring payment ok -> keep PRO
      if (type === "invoice.payment_succeeded") {
        const inv = event.data.object;
        const customerId = inv?.customer ? String(inv.customer) : "";
        const subscriptionId = inv?.subscription
          ? String(inv.subscription)
          : "";
        const key = findKeyByStripe(db, { subscriptionId, customerId });
        if (key) {
          const u = ensureUser(db, key);
          u.plan = "PRO";
          u.stripe.customerId = customerId || u.stripe.customerId;
          u.stripe.subscriptionId = subscriptionId || u.stripe.subscriptionId;
          u.stripe.status = "active";
        }
        addPayment(db, {
          ts: Date.now(),
          type,
          customerId,
          subscriptionId,
          invoiceId: inv?.id || null,
        });
      }

      // ✅ subscription updated -> reflect status
      if (type === "customer.subscription.updated") {
        const sub = event.data.object;
        const customerId = sub?.customer ? String(sub.customer) : "";
        const subscriptionId = sub?.id ? String(sub.id) : "";
        const status = String(sub?.status || "").toLowerCase(); // active|trialing|past_due|canceled...
        const key = findKeyByStripe(db, { subscriptionId, customerId });
        if (key) {
          const u = ensureUser(db, key);
          const isActive =
            status === "active" ||
            status === "trialing" ||
            status === "past_due";
          u.plan = isActive ? "PRO" : "FREE";
          u.stripe.status = status || u.stripe.status;
        }
      }

      // ✅ subscription canceled -> FREE
      if (type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const customerId = sub?.customer ? String(sub.customer) : "";
        const subscriptionId = sub?.id ? String(sub.id) : "";
        const key = findKeyByStripe(db, { subscriptionId, customerId });
        if (key) {
          const u = ensureUser(db, key);
          u.plan = "FREE";
          u.stripe.status = "canceled";
        }
      }

      markEventProcessed(db, event.id);
      writeDB(db);
      return res.json({ received: true });
    } catch (e) {
      console.error("webhook error:", e?.message || e);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

// ======================
// JSON parser for all other routes
// ======================
app.use(express.json({ limit: "1mb" }));

// ======================
// Health
// ======================
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    stripe: Boolean(stripe && STRIPE_PRICE_ID),
    byokOnly: BYOK_ONLY,
    models: MODELS,
    limits: LIMITS,
    allowedOrigins,
    ts: Date.now(),
  });
});

// ======================
// Me (plan + usage)
// ======================
app.get("/api/me", (req, res) => {
  const userId = getUserId(req);
  if (!userId)
    return res.status(400).json({ ok: false, error: "Missing x-gle-user" });

  const key = identityKey(req);
  const db = readDB();
  const u = ensureUser(db, key);
  writeDB(db);

  return res.json({
    ok: true,
    key,
    plan: u.plan,
    usage: u.usage,
    stripe: { status: u?.stripe?.status || null },
    byokOnly: BYOK_ONLY,
    limits: LIMITS,
    ts: Date.now(),
  });
});

// ======================
// Checkout: create session (subscription)
// ======================
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

    const accountId = identityKey(req);
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });
    if (!STRIPE_PRICE_ID)
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID" });

    const db = readDB();
    ensureUser(db, accountId);
    writeDB(db);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,

      // mapping
      client_reference_id: accountId,
      metadata: { accountId, userId, app: "gle" },
      subscription_data: { metadata: { accountId, app: "gle" } },

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
// Billing Portal (Self-Serve)
// body: { sessionId: "cs_..." }
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
      return res.status(400).json({ error: "No customer on checkout session" });

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
// Admin: link subscription manually (optional)
// Header: x-admin-token: <ADMIN_TOKEN>
// body: { accountId, subscriptionId }
// ======================
app.post("/api/admin/link-subscription", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });

    const token = getHeader(req, "x-admin-token");
    if (token !== ADMIN_TOKEN)
      return res.status(403).json({ error: "forbidden" });

    const accountId = String(req.body?.accountId || "").trim();
    const subscriptionId = String(req.body?.subscriptionId || "").trim();
    if (!accountId) return res.status(400).json({ error: "missing accountId" });
    if (!subscriptionId.startsWith("sub_"))
      return res.status(400).json({ error: "missing/invalid subscriptionId" });

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const status = String(sub?.status || "").toLowerCase();
    const okStatus = ["active", "trialing", "past_due"].includes(status);
    if (!okStatus)
      return res.status(400).json({ error: "subscription not active" });

    const db = readDB();
    const u = ensureUser(db, accountId);
    u.plan = "PRO";
    u.stripe.customerId = String(sub.customer || "");
    u.stripe.subscriptionId = subscriptionId;
    u.stripe.status = status;
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

// ======================
// OpenAI (Responses API) — used by /api/generate and /api/test
// ======================
function extractResponseText(json) {
  if (!json) return "";
  if (typeof json.output_text === "string" && json.output_text.trim())
    return json.output_text.trim();
  try {
    const out = Array.isArray(json.output) ? json.output : [];
    for (const item of out) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (
          c?.type === "output_text" &&
          typeof c?.text === "string" &&
          c.text.trim()
        )
          return c.text.trim();
        if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();
      }
    }
  } catch {}
  return "";
}

async function callOpenAI({
  apiKey,
  model,
  systemText,
  userText,
  maxOutputTokens = 900,
  timeoutMs = 60000,
}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const isGpt5 = /^gpt-5/i.test(model);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemText }] },
      { role: "user", content: [{ type: "input_text", text: userText }] },
    ],
    max_output_tokens: maxOutputTokens,
  };

  // only attach reasoning for gpt-5 models (safer)
  if (isGpt5) body.reasoning = { effort: "minimal" };

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const reqId =
      r.headers.get("openai-request-id") || r.headers.get("x-request-id") || "";
    const json = await r.json().catch(() => ({}));

    if (!r.ok) {
      const msg =
        json?.error?.message || json?.message || `OpenAI error (${r.status})`;
      const err = new Error(msg);
      err.status = r.status;
      err.requestId = reqId;
      throw err;
    }

    return {
      text: extractResponseText(json),
      usage: json?.usage || null,
      requestId: reqId,
    };
  } finally {
    clearTimeout(t);
  }
}

// ======================
// Test BYOK key
// ======================
app.get("/api/test", async (req, res) => {
  try {
    const key = getHeader(req, "x-openai-key");
    if (!key)
      return res.status(400).json({ ok: false, error: "Missing x-openai-key" });

    const r = await callOpenAI({
      apiKey: key,
      model: MODELS.byok,
      systemText: "Reply with exactly one word: OK",
      userText: "OK",
      maxOutputTokens: 16,
      timeoutMs: 20000,
    });

    const out = String(r.text || "").trim();
    if (!out)
      return res.status(502).json({ ok: false, error: "No text from OpenAI" });

    return res.json({ ok: true, text: out, requestId: r.requestId });
  } catch (e) {
    return res
      .status(e?.status || 500)
      .json({ ok: false, error: e?.message || "Key test failed" });
  }
});

// ======================
// Generate (Master Prompt)
// ======================
app.post("/api/generate", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

    const key = identityKey(req);
    const db = readDB();
    const u = ensureUser(db, key);

    const byokKey = getHeader(req, "x-openai-key");
    const wantsServer = !byokKey;

    if (BYOK_ONLY && wantsServer) {
      return res
        .status(402)
        .json({ error: "BYOK-only aktiv: Bitte OpenAI Key eintragen." });
    }

    const plan = u.plan === "PRO" ? "PRO" : "FREE";
    if (wantsServer && plan !== "PRO") {
      return res
        .status(402)
        .json({
          error: "FREE: Bitte OpenAI Key eintragen ODER PRO aktivieren.",
        });
    }
    if (wantsServer && !SERVER_OPENAI_API_KEY) {
      return res.status(500).json({ error: "SERVER_OPENAI_API_KEY fehlt" });
    }

    const useCase = String(req.body?.useCase || "").trim();
    const tone = String(req.body?.tone || "").trim();
    const language = String(req.body?.language || "").trim();
    const topic = String(req.body?.topic || "").trim();
    const extra = String(req.body?.extra || "").trim();
    const boost = Boolean(req.body?.boost);

    if (!topic) return res.status(400).json({ error: "Missing topic" });

    // quota only for server usage
    if (wantsServer) {
      const used = Number(u?.usage?.used || 0);
      const limit = LIMITS.pro;
      if (used >= limit) {
        return res.status(429).json({
          error: `Limit erreicht (${used}/${limit}). Reset am ${new Date(
            Number(u?.usage?.renewAt || nextMonthFirstDayMs())
          ).toLocaleDateString("de-DE")}.`,
        });
      }
    }

    const model = boost ? MODELS.boost : wantsServer ? MODELS.pro : MODELS.byok;
    const apiKeyToUse = wantsServer ? SERVER_OPENAI_API_KEY : byokKey;

    const isEN = /english|englisch/i.test(language);
    const systemText = isEN
      ? `You are "GLE Prompt Studio". Create ONE high-quality MASTER PROMPT the user can paste into ChatGPT/Claude/etc. Output ONLY the master prompt text.`
      : `Du bist "GLE Prompt Studio". Erstelle EINEN hochwertigen MASTER-PROMPT zum Copy/Paste in ChatGPT/Claude/etc. Gib NUR den Master-Prompt-Text aus.`;

    const userText = isEN
      ? `Use Case: ${useCase || "-"}
Tone: ${tone || "-"}
Language: ${language || "English"}
Topic/Context: ${topic}
Extra: ${extra || "-"}
Requirements:
- Include role + goal + constraints + structure + style + length guidance.
- Add max 3 clarifying questions ONLY if critical info is missing.
- Provide an output format template matching the use case.
- Copy/paste ready.`
      : `Use Case: ${useCase || "-"}
Ton: ${tone || "-"}
Sprache: ${language || "Deutsch"}
Thema/Kontext: ${topic}
Zusatz: ${extra || "-"}
Anforderungen:
- Rolle + Ziel + Rahmenbedingungen + Struktur + Stil + Längenvorgabe.
- Max. 3 Rückfragen NUR wenn wirklich Infos fehlen.
- Output-Format-Vorlage passend zum Use Case.
- Copy/Paste ready.`;

    const r = await callOpenAI({
      apiKey: apiKeyToUse,
      model,
      systemText,
      userText,
      maxOutputTokens: boost ? 1600 : 900,
      timeoutMs: boost ? 90000 : 60000,
    });

    const out = String(r.text || "").trim();
    if (!out)
      return res.status(502).json({ error: "Keine Textausgabe erhalten." });

    // track server usage
    if (wantsServer) {
      u.usage.used = Number(u.usage.used || 0) + 1;
      u.usage.lastTs = Date.now();
      writeDB(db);
    } else {
      writeDB(db);
    }

    return res.json({
      ok: true,
      result: out,
      output: out,
      meta: {
        model,
        plan,
        isBYOK: !wantsServer,
        boost,
        requestId: r.requestId || "",
      },
    });
  } catch (e) {
    console.error("generate error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "generate_failed" });
  }
});

// ======================
// Start
// ======================
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   CORS_ORIGIN=${CORS_ORIGIN}`);
  console.log(
    `   Stripe=${Boolean(stripe && STRIPE_PRICE_ID)} Price=${
      STRIPE_PRICE_ID ? "set" : "missing"
    }`
  );
});
