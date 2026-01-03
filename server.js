// backend/server.js — GLE Prompt Studio Backend (COMPLETE, COPY/PASTE)
// Stripe Checkout + Webhook (raw safe) + JSON DB (Plan/Usage) + BYOK/PRO/BOOST generate
// Headers:
//   x-gle-user  = usage identity
//   x-gle-acc   = stable account identity (Stripe mapping)
//   x-openai-key = BYOK key (optional)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const app = express();

// ======================
// Config
// ======================
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

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

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// CORS (muss VOR den Routes stehen)
const corsOptions = {
  origin: function (origin, cb) {
    // erlaubt Calls ohne Origin (curl, server-to-server)
    if (!origin) return cb(null, true);

    const allowed = [
      "http://localhost:3001",
      process.env.FRONTEND_URL,
      process.env.CORS_ORIGIN,
    ].filter(Boolean);

    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-gle-acc",
    "x-gle-user",
    "x-account-id",
    "x-admin-token",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

const cors = require("cors");

app.use(
  cors({
    origin: true, // spiegelt den Origin zurück (localhost + später Vercel/Domain)
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-gle-acc",
      "x-gle-user",
    ],
  })
);

// Preflight für alle Endpunkte sauber beantworten
app.options("*", cors({ origin: true, credentials: true }));

// Preflight überall erlauben
app.options("*", cors());

// CORS (muss VOR den Routes stehen)
app.use(
  cors({
    origin: (origin, cb) => cb(null, origin || true),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-gle-acc",
      "x-gle-user",
      "x-account-id",
      "x-admin-token",
    ],
  })
);
app.options("*", cors());

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PRICE_ID = String(process.env.STRIPE_PRICE_ID || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" })
  : null;

// Optional Admin token for linking existing subs without new checkout
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

// ======================
// CORS
// ======================
app.use(
  cors({
    origin: function (origin, cb) {
      // allow server-to-server, same-origin, and dev tools without Origin header
      if (!origin) return cb(null, true);
      if (CORS_ORIGIN === "*" || origin === CORS_ORIGIN) return cb(null, true);
      // allow localhost variants if CORS_ORIGIN is localhost
      if (
        CORS_ORIGIN.includes("localhost") &&
        (origin.includes("localhost") || origin.includes("127.0.0.1"))
      ) {
        return cb(null, true);
      }
      return cb(null, true); // keep permissive for dev
    },
    credentials: true,
  })
);

// ======================
// DB (JSON)
// ======================
const DB_FILE = path.join(__dirname, "gle_users.json");

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2), "utf8");
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    if (!data.users) data.users = {};
    return data;
  } catch {
    return { users: {} };
  }
}

function writeDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("DB write failed:", e?.message || e);
  }
}

function nextMonthFirstDayMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function getUserId(req) {
  return String(req.headers["x-gle-user"] || "").trim();
}

function getAccountId(req) {
  // you wanted x-gle-acc (clear meaning)
  return String(req.headers["x-gle-acc"] || "").trim();
}

function identityKey(req) {
  return getAccountId(req) || getUserId(req);
}

function ensureUser(db, key) {
  if (!db.users[key]) {
    db.users[key] = {
      plan: "FREE",
      usage: { used: 0, renewAt: nextMonthFirstDayMs() },
      stripeCustomerId: "",
      stripeSubId: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  // auto reset monthly
  const u = db.users[key];
  const renewAt = Number(u?.usage?.renewAt || nextMonthFirstDayMs());
  if (Date.now() >= renewAt) {
    u.usage = { used: 0, renewAt: nextMonthFirstDayMs() };
    u.updatedAt = Date.now();
  }
  return db.users[key];
}

function setPlanPro(key, fields = {}) {
  const db = readDB();
  const u = ensureUser(db, key);
  u.plan = "PRO";
  u.updatedAt = Date.now();
  if (fields.stripeCustomerId)
    u.stripeCustomerId = String(fields.stripeCustomerId);
  if (fields.stripeSubId) u.stripeSubId = String(fields.stripeSubId);
  writeDB(db);
  return u;
}

function setPlanFree(key) {
  const db = readDB();
  const u = ensureUser(db, key);
  u.plan = "FREE";
  u.updatedAt = Date.now();
  writeDB(db);
  return u;
}

function findKeyBySubId(subId) {
  const db = readDB();
  const keys = Object.keys(db.users || {});
  for (const k of keys) {
    if (String(db.users[k]?.stripeSubId || "") === String(subId || ""))
      return k;
  }
  return null;
}

// ======================
// OpenAI (Responses API)
// ======================
function extractResponseText(json) {
  if (!json) return "";
  if (typeof json.output_text === "string") return json.output_text.trim();

  // fallback: output array
  try {
    const out = json.output || [];
    for (const item of out) {
      const content = item?.content || [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") {
          return c.text.trim();
        }
        if (typeof c?.text === "string") return c.text.trim();
      }
    }
  } catch {}

  // last resort
  return String(json.text || json.result || "").trim();
}

async function callOpenAI({ apiKey, model, input }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      // IMPORTANT: do NOT set temperature here (you had model errors before)
    }),
  });

  const requestId = res.headers.get("x-request-id") || "";
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      json?.error ||
      `OpenAI error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.requestId = requestId;
    throw err;
  }

  return {
    text: extractResponseText(json),
    usage: json?.usage || null,
    requestId,
    raw: json,
  };
}

// ======================
// Health
// ======================
app.get("/api/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    stripe: Boolean(stripe && STRIPE_PRICE_ID),
    byokOnly: BYOK_ONLY,
    models: MODELS,
    limits: LIMITS,
    ts: Date.now(),
  });
});

// ======================
// Stripe Webhook (RAW SAFE)
// ======================
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(500).send("Stripe not configured");
    if (!STRIPE_WEBHOOK_SECRET)
      return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // ✅ Subscription created via Checkout
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const accountId =
          session.client_reference_id ||
          (session.metadata && session.metadata.accountId) ||
          null;

        if (!accountId) {
          console.error(
            "NO accountId on session => cannot activate PRO",
            session.id
          );
          return res.json({ received: true });
        }

        const subId = session.subscription ? String(session.subscription) : "";
        const customerId = session.customer ? String(session.customer) : "";

        setPlanPro(String(accountId), {
          stripeCustomerId: customerId,
          stripeSubId: subId,
        });

        console.log(
          "✅ PRO activated for x-gle-acc:",
          accountId,
          "sub:",
          subId
        );
      }

      // ✅ Subscription cancelled
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const subId = String(sub.id || "");

        const accountId =
          (sub.metadata && sub.metadata.accountId) ||
          sub.items?.data?.[0]?.metadata?.accountId ||
          findKeyBySubId(subId);

        if (accountId) {
          setPlanFree(String(accountId));
          console.log(
            "🟡 PRO removed for x-gle-acc:",
            accountId,
            "sub:",
            subId
          );
        } else {
          console.log("subscription.deleted but no accountId mapping:", subId);
        }
      }

      return res.json({ received: true });
    } catch (e) {
      console.error("webhook handler error:", e?.message || e);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

// ======================
// Checkout: create session (POST JSON)
// ======================
app.post("/api/create-checkout-session", express.json(), async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });
    if (!STRIPE_PRICE_ID)
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID" });

    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

    const accFromHeader = getAccountId(req);
    const accFromBody = String(req.body?.accountId || "").trim();
    const accountId = accFromBody || accFromHeader || userId;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],

      // ✅ mapping App <-> Stripe
      client_reference_id: accountId,
      metadata: { accountId, app: "gle" },
      subscription_data: { metadata: { accountId, app: "gle" } },

      allow_promotion_codes: true,

      success_url: `${FRONTEND_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e?.message || e);
    return res.status(500).json({ error: "checkout_failed" });
  }
});

// ======================
// Billing Portal (POST JSON)
// ======================
app.post("/api/billing-portal", express.json(), async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "Missing/invalid sessionId" });
    }

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const customer = checkoutSession.customer;
    if (!customer)
      return res.status(400).json({ error: "No customer on session" });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.toString(),
      return_url: `${FRONTEND_URL}/?from=portal`,
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
// OPTIONAL: Link an existing Stripe subscription to x-gle-acc
// (NO new checkout, NO new subscription)
// ======================
app.post("/api/admin/link-subscription", express.json(), async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not configured" });
    if (!ADMIN_TOKEN)
      return res.status(403).json({ error: "ADMIN_TOKEN not set" });

    const token = String(req.headers["x-admin-token"] || "").trim();
    if (token !== ADMIN_TOKEN)
      return res.status(403).json({ error: "forbidden" });

    const accountId = String(
      req.body?.accountId || getAccountId(req) || ""
    ).trim();
    const subscriptionId = String(req.body?.subscriptionId || "").trim();

    if (!accountId) return res.status(400).json({ error: "missing accountId" });
    if (!subscriptionId.startsWith("sub_"))
      return res.status(400).json({ error: "missing/invalid subscriptionId" });

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    if (
      !sub ||
      !["active", "trialing", "past_due"].includes(String(sub.status || ""))
    ) {
      return res.status(400).json({ error: "subscription not active" });
    }

    setPlanPro(accountId, {
      stripeCustomerId: String(sub.customer || ""),
      stripeSubId: subscriptionId,
    });

    return res.json({ ok: true, linked: true, accountId, subscriptionId });
  } catch (e) {
    console.error("link-subscription error:", e?.message || e);
    return res.status(500).json({ error: "link_failed" });
  }
});

// ======================
// /api/me — plan + usage (GET)
// ======================
app.get("/api/me", (req, res) => {
  const userId = getUserId(req);
  if (!userId)
    return res.status(400).json({ ok: false, error: "Missing x-gle-user" });

  const key = identityKey(req) || userId;

  const db = readDB();
  const u = ensureUser(db, key);
  writeDB(db);

  return res.json({
    ok: true,
    key,
    plan: u.plan === "PRO" ? "PRO" : "FREE",
    usage: u.usage || { used: 0, renewAt: nextMonthFirstDayMs() },
    byokOnly: BYOK_ONLY,
    limits: LIMITS,
  });
});

// ======================
// /api/test — validate BYOK key (GET)
// ======================
app.get("/api/test", async (req, res) => {
  const apiKey = String(req.headers["x-openai-key"] || "").trim();
  if (!apiKey)
    return res.status(400).json({ ok: false, error: "Missing x-openai-key" });

  try {
    const r = await callOpenAI({
      apiKey,
      model: MODELS.byok,
      input: "Reply with exactly: OK",
    });

    const text = (r.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "No output" });

    return res.json({ ok: true, text });
  } catch (e) {
    return res
      .status(401)
      .json({ ok: false, error: e?.message || "Key invalid" });
  }
});

// ======================
// /api/generate — main (POST JSON)
// ======================
app.post("/api/generate", express.json(), async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

  const key = identityKey(req) || userId;
  const db = readDB();
  const u = ensureUser(db, key);

  const byokKey = String(req.headers["x-openai-key"] || "").trim();

  const useCase = String(req.body?.useCase || "").trim();
  const tone = String(req.body?.tone || "").trim();
  const language = String(req.body?.language || "").trim();
  const topic = String(req.body?.topic || "").trim();
  const extra = String(req.body?.extra || "").trim();
  const boost = Boolean(req.body?.boost);

  if (!topic) return res.status(400).json({ error: "Missing topic" });

  // Decide if we may use server key
  const plan = u.plan === "PRO" ? "PRO" : "FREE";
  const wantsServer = !byokKey;

  if (BYOK_ONLY && wantsServer) {
    return res
      .status(401)
      .json({ error: "BYOK-only aktiv: Bitte OpenAI Key eintragen." });
  }

  if (wantsServer) {
    if (plan !== "PRO") {
      return res.status(402).json({
        error: "FREE: Bitte OpenAI Key eintragen ODER PRO aktivieren.",
      });
    }
    if (!SERVER_OPENAI_API_KEY) {
      return res.status(500).json({ error: "SERVER_OPENAI_API_KEY fehlt" });
    }

    // quota for server credits
    const used = Number(u?.usage?.used || 0);
    const limit = LIMITS.pro;
    if (used >= limit) {
      return res.status(402).json({
        error: `Limit erreicht (${used}/${limit}). Reset am ${new Date(
          Number(u?.usage?.renewAt || nextMonthFirstDayMs())
        ).toLocaleDateString("de-DE")}.`,
      });
    }
  }

  const model = boost ? MODELS.boost : wantsServer ? MODELS.pro : MODELS.byok;
  const apiKeyToUse = wantsServer ? SERVER_OPENAI_API_KEY : byokKey;

  // Prompt to generate a MASTER-PROMPT (not final content)
  const lang = /englisch|english/i.test(language) ? "EN" : "DE";
  const sys =
    lang === "EN"
      ? `You are "GLE Prompt Studio". Create a high-quality MASTER PROMPT that the user can paste into ChatGPT/Claude/etc. Output ONLY the master prompt text.`
      : `Du bist "GLE Prompt Studio". Erstelle einen hochwertigen MASTER-PROMPT, den man direkt in ChatGPT/Claude/etc. einfügt. Gib NUR den Master-Prompt-Text aus.`;

  const body =
    lang === "EN"
      ? `
${sys}

Use Case: ${useCase || "-"}
Tone: ${tone || "-"}
Language: ${language || "English"}
Topic/Context: ${topic}
Extra: ${extra || "-"}

Requirements:
- Include role + goal + constraints + structure + style + length guidance.
- Add a short "Questions to clarify" section (max 3) ONLY if information is missing.
- Add an output format template matching the use case.
- Make it copy/paste ready.
`
      : `
${sys}

Use Case: ${useCase || "-"}
Ton: ${tone || "-"}
Sprache: ${language || "Deutsch"}
Thema/Kontext: ${topic}
Zusatz: ${extra || "-"}

Anforderungen:
- Rolle + Ziel + Rahmenbedingungen + Struktur + Stil + Längenvorgabe.
- Max. 3 Rückfragen NUR wenn wirklich Infos fehlen.
- Output-Format-Vorlage passend zum Use Case.
- Copy/Paste ready.
`;

  try {
    const r = await callOpenAI({
      apiKey: apiKeyToUse,
      model,
      input: body,
    });

    const text = (r.text || "").trim();
    if (!text)
      return res.status(500).json({ error: "Keine Textausgabe erhalten." });

    // increment server usage AFTER success
    if (wantsServer && plan === "PRO" && !BYOK_ONLY) {
      u.usage.used = Number(u?.usage?.used || 0) + 1;
      u.updatedAt = Date.now();
      db.users[key] = u;
      writeDB(db);
    }

    const tokens =
      Number(r?.usage?.total_tokens || 0) ||
      Number(r?.usage?.input_tokens || 0) +
        Number(r?.usage?.output_tokens || 0) ||
      0;

    return res.json({
      ok: true,
      result: text,
      meta: {
        model,
        tokens: tokens || undefined,
        boost,
        plan,
        isBYOK: !wantsServer,
        requestId: r.requestId || undefined,
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
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(
    `   Models: BYOK=${MODELS.byok} | PRO=${MODELS.pro} | BOOST=${MODELS.boost}`
  );
  console.log(`   Limits: FREE=${LIMITS.free} | PRO=${LIMITS.pro}`);
  console.log(
    `   Stripe=${Boolean(stripe && STRIPE_PRICE_ID)} Price=${
      STRIPE_PRICE_ID ? "set" : "missing"
    }`
  );
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
});
