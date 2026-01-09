/* server.js — GLE Prompt Studio Backend (FINAL, UNKAPUTTBAR)
   - Checkout: NIEMALS 400 nur wegen fehlendem accountId Header (Fallback + Warn-Log)
   - Logs: Request-Logs für Render Live Tail
   - Health: buildTag sichtbar (sofort sehen ob Render wirklich den richtigen Stand hat)
   - Stripe Checkout: "card" + "paypal" (PayPal bleibt), KEIN Amazon Pay
   - PRO Aktivierung: /api/sync-checkout-session + optional Stripe Webhook
*/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const app = express();

/* ======================
   1) Config / ENV
====================== */
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const BUILD_TAG = String(
  process.env.BUILD_TAG || process.env.RENDER_GIT_COMMIT || "local"
).trim();

const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

// Models (Responses API)
const MODEL_BYOK = String(process.env.MODEL_BYOK || "gpt-4o-mini").trim();
const MODEL_PRO = String(process.env.MODEL_PRO || "gpt-4o-mini").trim();
const MODEL_BOOST = String(process.env.MODEL_BOOST || "gpt-5").trim();

const REASONING_EFFORT = String(
  process.env.REASONING_EFFORT || "low"
).trim(); // low|medium|high

const DEFAULT_MAX_OUT = Number(process.env.DEFAULT_MAX_OUT || 900);
const BOOST_MAX_OUT = Number(process.env.BOOST_MAX_OUT || 1600);

// Limits
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

// OpenAI server key (PRO ohne BYOK)
const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || ""
).trim();

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

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
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveDb();
  }
  const u = db.users[id];
  resetIfNeeded(u);
  u.updatedAt = Date.now();
  return u;
}

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
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
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
    ts: Date.now(),
  });
});

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

    u.usage.used += 1;
    u.usage.tokens += Number(tokens || 0);
    u.usage.lastTs = Date.now();
    saveDb();

    return res.json({
      ok: true,
      result: text,
      meta: {
        model: raw?.model || modelToUse,
        tokens: Number(tokens || 0),
        boost: !!wantsBoost,
        plan,
        isBYOK,
        billedToServer: !isBYOK,
        accountId,
        buildTag: BUILD_TAG,
        requestId: raw?.id || null,
      },
    });
  } catch (e) {
    console.error("generate error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "generate_failed" });
  }
});

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
});
