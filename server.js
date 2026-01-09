/* server.js — GLE Prompt Studio Backend (FINAL, UNKAPUTTBAR)
   - Checkout: NIEMALS 400 nur wegen fehlendem accountId Header
   - 500 eliminieren: CORS wirft nie Error + Stripe-Fehler -> 400 mit Details
   - Health: buildTag + Stripe-Mode sichtbar
   - Stripe Checkout: ["card","paypal"] (PayPal bleibt), KEIN Amazon Pay
*/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const app = express();

// ======================
// Env / Config
// ======================
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

// ✅ build marker (Render)
const BUILD_TAG = String(
  process.env.BUILD_TAG || process.env.RENDER_GIT_COMMIT || "local"
).trim();

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
const PRO_BOOST_LIMIT = Number(process.env.PRO_BOOST_LIMIT || 50);

// OpenAI Server Key (für PRO, wenn BYOK_ONLY=false)
const SERVER_OPENAI_API_KEY = String(process.env.SERVER_OPENAI_API_KEY || "").trim();

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();

// ✅ kompatibel: PRO-Price kann STRIPE_PRICE_ID_PRO ODER STRIPE_PRICE_ID heißen
const STRIPE_PRICE_ID_PRO = String(
  process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID || ""
).trim();

// Optional URLs
const STRIPE_SUCCESS_URL = String(
  process.env.STRIPE_SUCCESS_URL ||
    `${FRONTEND_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`
).trim();
const STRIPE_CANCEL_URL = String(
  process.env.STRIPE_CANCEL_URL || `${FRONTEND_URL}/checkout-cancel`
).trim();

// Admin
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

// DB
const DB_FILE = String(process.env.DB_FILE || path.join(__dirname, "db.json")).trim();

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
  const raw = String(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "").trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
})();

// Stripe client
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const STRIPE_MODE = STRIPE_SECRET_KEY.startsWith("sk_live_")
  ? "live"
  : STRIPE_SECRET_KEY.startsWith("sk_test_")
  ? "test"
  : STRIPE_SECRET_KEY
  ? "unknown"
  : "missing";

// ======================
// Request logs (Render Live Tail)
// ======================
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const origin = req.headers.origin || "";
    const user = req.headers["x-gle-user"] || "-";
    const acc = req.headers["x-gle-account-id"] || req.headers["x-gle-acc"] || "-";
    if (
      req.originalUrl.startsWith("/api/create-checkout-session") ||
      req.originalUrl.startsWith("/api/me") ||
      req.originalUrl.startsWith("/api/generate") ||
      req.originalUrl.startsWith("/api/health")
    ) {
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) origin=${origin} user=${user} acc=${acc}`
      );
    }
  });
  next();
});

// ======================
// CORS + Body (CORS darf NIE 500 werfen)
// ======================
app.use(
  cors({
    origin: (origin, cb) => {
      // server-to-server / curl ohne Origin erlauben
      if (!origin) return cb(null, true);
      // ✅ niemals Error werfen -> kein 500
      return cb(null, ALLOWED_ORIGINS.includes(origin));
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
    ],
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204,
  })
);

// Preflight sauber
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

// ======================
// DB (simple JSON) + safe IO
// ======================
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

let db = loadDb();

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return { users: {}, checkouts: {} };
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

// ======================
// Helpers
// ======================
function getUserId(req) {
  return String(req.headers["x-gle-user"] || req.body?.userId || "").trim() || "anon";
}

function getAccountId(req) {
  return String(
    req.headers["x-gle-account-id"] ||
      req.headers["x-gle-acc"] ||
      req.body?.accountId ||
      req.body?.acc ||
      ""
  ).trim();
}

function fallbackAccountIdFromUser(userId) {
  const safe = String(userId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-24);
  return `acc_${safe || Date.now()}`;
}

function getAdminToken(req) {
  return String(req.headers["x-admin-token"] || "").trim();
}

function computeLimit(plan) {
  return String(plan || "FREE").toUpperCase() === "PRO" ? PRO_LIMIT : FREE_LIMIT;
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

function stripeErrorToJson(err) {
  return {
    error: "stripe_error",
    message:
      (err && err.raw && err.raw.message) ||
      (err && err.message) ||
      String(err),
    type: err && err.type,
    code: err && err.code,
    param: err && err.param,
    requestId: err && err.requestId,
    raw: err && err.raw ? { type: err.raw.type, code: err.raw.code } : null,
  };
}

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
    stripeMode: STRIPE_MODE, // ✅ test/live sichtbar
    stripePriceId: STRIPE_PRICE_ID_PRO || null,
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

    const userKey = String(req.headers["x-openai-key"] || req.body?.openaiKey || "")
      .trim()
      .replace(/^Bearer\s+/i, "");

    const needsUserKey = BYOK_ONLY || plan === "FREE";
    const apiKey = needsUserKey ? userKey : (SERVER_OPENAI_API_KEY || userKey);

    if (!apiKey) {
      return res.status(400).json({
        error: "missing_openai_key",
        hint: needsUserKey
          ? "FREE/BYOK: x-openai-key required"
          : "PRO: SERVER_OPENAI_API_KEY missing (or provide x-openai-key)",
      });
    }

    if (user.usage.used >= limit) {
      return res.status(429).json({
        error: "quota_reached",
        plan,
        limit,
        used: user.usage.used,
        renewAt: user.usage.renewAt,
      });
    }

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

    const model = useBoost ? MODEL_BOOST : (plan === "PRO" ? MODEL_PRO : MODEL_BYOK);

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
// Stripe Checkout Session (PRO)
// ----------------------
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    // ✅ diese Fälle sind CONFIG -> 400 (kein 500)
    if (!stripe) {
      return res.status(400).json({ error: "stripe_not_configured", hint: "STRIPE_SECRET_KEY missing" });
    }
    if (!STRIPE_PRICE_ID_PRO) {
      return res.status(400).json({
        error: "stripe_price_missing",
        hint: "Set STRIPE_PRICE_ID_PRO (or STRIPE_PRICE_ID) in Render env",
      });
    }

    const userId = getUserId(req);

    // ✅ accountId optional
    let accountId = getAccountId(req);
    if (!accountId) accountId = fallbackAccountIdFromUser(userId);

    ensureUser(userId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID_PRO, quantity: 1 }],
      allow_promotion_codes: true,

      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,

      client_reference_id: `${userId}:${accountId}`.slice(0, 200),
      metadata: { userId, accountId },

      // ✅ PayPal bleibt, Amazon Pay raus
      // (keine automatic_payment_methods!)
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
  } catch (e) {
    console.error("Stripe checkout error FULL:", e);

    // ✅ Stripe InvalidRequest etc. -> 400 mit echter Message (damit 500 weg ist)
    const isStripe = e && (String(e.type || "").startsWith("Stripe") || e.raw);
    const status = isStripe ? 400 : 500;

    return res.status(status).json(stripeErrorToJson(e));
  }
});

// ----------------------
// DEV: Plan setzen (admin)
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
  console.log(`   buildTag=${BUILD_TAG}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(`   Stripe=${Boolean(stripe)} mode=${STRIPE_MODE} price=${STRIPE_PRICE_ID_PRO ? "set" : "missing"}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   AllowedOrigins=${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`   DB_FILE=${DB_FILE}`);
});
