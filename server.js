// /server.js — GLE Prompt Studio Backend (STABLE)
// BYOK + PRO(Server-Key) + Stripe Checkout + (optional) Webhook + JSON DB
// NEW: BUILD_TAG in /api/health + Checkout nur "card" (kein Amazon Pay / PayPal Noise)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2 (oder Node 18+ global fetch)
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const app = express();

// ======================
// Config
// ======================
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const BUILD_TAG = String(process.env.BUILD_TAG || "").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

// Models
const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o-mini").trim();
const MODEL_BOOST = String(process.env.MODEL_BOOST || "gpt-5").trim();

// Limits
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

// Boost (Quality Boost) credits (optional)
const PRO_BOOST_LIMIT = Number(process.env.PRO_BOOST_LIMIT || 50);

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PRICE_ID_PRO = String(process.env.STRIPE_PRICE_ID_PRO || "").trim();
// success/cancel URLs (fallback to FRONTEND_URL)
const STRIPE_SUCCESS_URL = String(
  process.env.STRIPE_SUCCESS_URL ||
    `${FRONTEND_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`
).trim();
const STRIPE_CANCEL_URL = String(
  process.env.STRIPE_CANCEL_URL || `${FRONTEND_URL}/checkout-cancel`
).trim();

// Admin token (dev endpoints)
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

// CORS origins
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

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// DB
const DB_FILE = String(process.env.DB_FILE || path.join(__dirname, "db.json"));
let db = loadDb();

// ======================
// Helpers
// ======================
function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return { users: {}, checkouts: {} };
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

function saveDb() {
  try {
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

function ensureUser(userId) {
  const id = String(userId || "anon").trim() || "anon";
  if (!db.users[id]) {
    db.users[id] = {
      plan: "FREE",
      usage: { used: 0, renewAt: nextMonthFirstDayTs() },
      boost: { used: 0, limit: PRO_BOOST_LIMIT, renewAt: nextMonthFirstDayTs() },
      stripe: { customerId: null, subscriptionId: null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveDb();
  }
  return db.users[id];
}

function resetIfNeeded(user) {
  const now = Date.now();
  if (!user.usage || typeof user.usage.used !== "number") {
    user.usage = { used: 0, renewAt: nextMonthFirstDayTs() };
  }
  if (now >= Number(user.usage.renewAt || 0)) {
    user.usage.used = 0;
    user.usage.renewAt = nextMonthFirstDayTs();
  }

  if (!user.boost || typeof user.boost.used !== "number") {
    user.boost = { used: 0, limit: PRO_BOOST_LIMIT, renewAt: nextMonthFirstDayTs() };
  }
  if (now >= Number(user.boost.renewAt || 0)) {
    user.boost.used = 0;
    user.boost.renewAt = nextMonthFirstDayTs();
  }
}

function getUserId(req) {
  return (
    String(req.headers["x-gle-user"] || req.body?.userId || "")
      .trim() || "anon"
  );
}

function getAccountId(req) {
  // Header ist PRIMARY (wie bei dir)
  return String(
    req.headers["x-gle-account-id"] || req.body?.accountId || ""
  ).trim();
}

function getAdminToken(req) {
  return String(req.headers["x-admin-token"] || "").trim();
}

function computeLimit(plan) {
  const p = String(plan || "FREE").toUpperCase();
  return p === "PRO" ? PRO_LIMIT : FREE_LIMIT;
}

function extractOutputText(respJson) {
  // OpenAI Responses API: resp.output_text ist am bequemsten, falls vorhanden.
  if (respJson && typeof respJson.output_text === "string" && respJson.output_text.trim()) {
    return respJson.output_text.trim();
  }

  // Fallback: aus output[] -> content[] -> text
  try {
    const out = respJson?.output;
    if (!Array.isArray(out)) return "";
    const texts = [];
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") {
          texts.push(c.text);
        }
        if (c?.type === "text" && typeof c?.text === "string") {
          texts.push(c.text);
        }
      }
    }
    return texts.join("\n").trim();
  } catch {
    return "";
  }
}

// ======================
// CORS + Body
// ======================
app.use(
  cors({
    origin: function (origin, callback) {
      // server-to-server / curl ohne Origin erlauben
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS not allowed: " + origin));
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-gle-user",
      "x-gle-account-id",
      "x-openai-key",
      "x-admin-token",
    ],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ======================
// Routes
// ======================
app.get("/", (req, res) => res.send("GLE Prompt Studio Backend OK"));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    buildTag: BUILD_TAG || null,
    stripe: Boolean(stripe) && Boolean(STRIPE_PRICE_ID_PRO),
    byokOnly: BYOK_ONLY,
    models: { byok: MODEL_BYOK, pro: MODEL_PRO, boost: MODEL_BOOST },
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    allowedOrigins: ALLOWED_ORIGINS,
    ts: Date.now(),
  });
});

app.get("/api/me", (req, res) => {
  const userId = getUserId(req);
  const user = ensureUser(userId);
  resetIfNeeded(user);
  user.updatedAt = Date.now();
  saveDb();

  res.json({
    user_id: userId,
    plan: user.plan,
    usage: user.usage,
    boost: user.boost,
    byokOnly: BYOK_ONLY,
  });
});

// ----------------------
// Generate (BYOK / PRO)
// ----------------------
app.post("/api/generate", async (req, res) => {
  try {
    const userId = getUserId(req);
    const user = ensureUser(userId);
    resetIfNeeded(user);

    const plan = String(user.plan || "FREE").toUpperCase();
    const limit = computeLimit(plan);

    const { prompt, qualityBoost } = req.body || {};
    const input = String(prompt || "").trim();
    if (!input) return res.status(400).json({ error: "missing_prompt" });

    // Key-Logik:
    // - BYOK_ONLY=true => immer User-Key nötig
    // - ansonsten: FREE => User-Key nötig, PRO => Server-Key erlaubt
    const userKey =
      String(req.headers["x-openai-key"] || req.body?.openaiKey || "")
        .trim()
        .replace(/^Bearer\s+/i, "");

    const serverKey = String(process.env.SERVER_OPENAI_API_KEY || "").trim();
    const needsUserKey = BYOK_ONLY || plan === "FREE";

    const apiKey = needsUserKey ? userKey : serverKey || userKey;

    if (!apiKey) {
      return res.status(400).json({
        error: "missing_openai_key",
        hint: needsUserKey
          ? "FREE/BYOK: x-openai-key required"
          : "PRO: SERVER_OPENAI_API_KEY missing (or provide x-openai-key)",
      });
    }

    // Quota (nur für Server-Usage tracken, bei BYOK kann man optional trotzdem zählen)
    // Hier zählen wir IMMER usage, weil dein Frontend das so erwartet:
    if (user.usage.used >= limit) {
      return res.status(429).json({
        error: "quota_reached",
        plan,
        limit,
        used: user.usage.used,
        renewAt: user.usage.renewAt,
      });
    }

    // Quality Boost (optional) nur bei PRO
    const useBoost = Boolean(qualityBoost) && plan === "PRO";
    if (useBoost) {
      const bLimit = Number(user.boost?.limit || PRO_BOOST_LIMIT);
      if (user.boost.used >= bLimit) {
        return res.status(429).json({
          error: "boost_quota_reached",
          boost: user.boost,
        });
      }
    }

    const model = useBoost ? MODEL_BOOST : plan === "PRO" ? MODEL_PRO : MODEL_BYOK;

    // OpenAI Responses API (ohne temperature, damit du keine "unsupported value" bekommst)
    const payload = {
      model,
      input,
      max_output_tokens: 1200,
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("OpenAI error:", r.status, data);
      return res.status(500).json({ error: "openai_error", status: r.status, details: data });
    }

    const text = extractOutputText(data);
    if (!text) {
      return res.status(500).json({ error: "no_text_from_openai", details: data });
    }

    // usage zählen
    user.usage.used += 1;
    if (useBoost) user.boost.used += 1;
    user.updatedAt = Date.now();
    saveDb();

    res.json({
      ok: true,
      plan,
      model,
      usage: user.usage,
      boost: user.boost,
      output: text,
    });
  } catch (e) {
    console.error("Generate error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ----------------------
// Stripe Checkout Session
// ----------------------
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });
    if (!STRIPE_PRICE_ID_PRO) return res.status(500).json({ error: "stripe_price_missing" });

    const userId = getUserId(req);
    const accountId = getAccountId(req);

    // bleibt bewusst strikt (weil du das im Frontend sauber brauchst)
    if (!accountId) {
      return res.status(400).json({ error: "Missing x-gle-account-id" });
    }

    const user = ensureUser(userId);
    resetIfNeeded(user);

    // WICHTIG: Hier NUR card erlauben => kein Amazon Pay / kein PayPal im Checkout
    // (Wenn du PayPal später wirklich willst: dashboard aktivieren + "paypal" hier ergänzen.)
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID_PRO, quantity: 1 }],
      allow_promotion_codes: true,

      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,

      client_reference_id: `${userId}:${accountId}`,
      metadata: { userId, accountId },

      payment_method_types: ["card"],
    });

    // optional: speichern
    db.checkouts[session.id] = {
      userId,
      accountId,
      createdAt: Date.now(),
      url: session.url,
    };
    saveDb();

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error("Stripe checkout error:", e);
    res.status(500).json({ error: "stripe_checkout_error" });
  }
});

// ----------------------
// DEV: Plan setzen (lokal / admin)
// ----------------------
app.post("/api/dev/set-plan", (req, res) => {
  const token = getAdminToken(req);
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const userId = String(req.body?.userId || getUserId(req) || "").trim() || "anon";
  const planRaw = String(req.body?.plan || "").toUpperCase().trim();
  const nextPlan = planRaw === "PRO" ? "PRO" : "FREE";

  const user = ensureUser(userId);
  user.plan = nextPlan;
  user.updatedAt = Date.now();
  saveDb();

  res.json({ ok: true, userId, plan: user.plan });
});

// ======================
// Start
// ======================
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   buildTag=${BUILD_TAG || "(none)"}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(`   Stripe=${Boolean(stripe)} Price=${STRIPE_PRICE_ID_PRO ? "set" : "missing"}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   AllowedOrigins=${ALLOWED_ORIGINS.join(", ")}`);
});
