// server.js — GLE Prompt Studio Backend (ROBUST, NO MORE 400 ON MISSING ACCOUNT)
// - accountId wird IMMER ermittelt (Header/Body/Query oder Fallback aus x-gle-user)
// - Stripe Checkout funktioniert auch wenn Frontend KEIN x-gle-account-id sendet
// - /api/health zeigt buildTag (BUILD_TAG) zum sicheren Verifizieren
// - CORS erlaubt custom headers (x-gle-account-id, x-gle-acc, x-gle-user, x-openai-key)

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();

/* ======================
   1) Config
====================== */
const PORT = Number(process.env.PORT || 3002);
const HOST = String(process.env.HOST || "0.0.0.0").trim();

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3001"
).trim();

const CORS_ORIGIN_RAW = String(
  process.env.CORS_ORIGIN ||
    "http://localhost:3001,http://127.0.0.1:3001,https://gle-prompt-studio.vercel.app,https://studio.getlaunchedge.com"
).trim();

const BUILD_TAG = String(process.env.BUILD_TAG || "").trim();

// OpenAI (optional)
const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

const SERVER_OPENAI_API_KEY = String(
  process.env.SERVER_OPENAI_API_KEY || ""
).trim();

const BYOK_MODEL = String(process.env.BYOK_MODEL || "gpt-4o-mini").trim();
const PRO_MODEL = String(process.env.PRO_MODEL || "gpt-4o-mini").trim();
const BOOST_MODEL = String(process.env.BOOST_MODEL || "gpt-5").trim();
const REASONING_EFFORT = String(process.env.REASONING_EFFORT || "low").trim(); // low|medium|high

const DEFAULT_MAX_OUT = Number(process.env.DEFAULT_MAX_OUT || 900);
const BOOST_MAX_OUT = Number(process.env.BOOST_MAX_OUT || 1600);

// Limits
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 25);
const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

// Stripe
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PRICE_ID = String(process.env.STRIPE_PRICE_ID || "").trim();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || ""
).trim();

// Admin
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

// DB (Render persistent disk recommended)
const DB_FILE = String(
  process.env.DB_FILE || path.join(__dirname, "gle_users.json")
).trim();

/* ======================
   2) Helpers
====================== */
function parseCsvList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
const ALLOWED_ORIGINS = parseCsvList(CORS_ORIGIN_RAW);

function isOriginAllowed(origin) {
  if (!origin) return true; // curl/no-origin
  return ALLOWED_ORIGINS.includes(origin);
}

function toSafeString(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function getUserId(req) {
  const h = req.headers || {};
  return toSafeString(h["x-gle-user"] || req.body?.userId || req.query?.userId);
}

// ✅ accountId: Header ODER Body ODER Query — sonst Fallback aus userId (stabil)
function fallbackAccountIdFromUser(userId) {
  const u = toSafeString(userId || "anon", 400);
  const hash = crypto.createHash("sha256").update(u).digest("hex").slice(0, 24);
  return `acc_${hash}`;
}

function getAccountId(req, userId) {
  const h = req.headers || {};
  const fromHeader = h["x-gle-account-id"] || h["x-gle-acc"];
  const fromBody = req.body && (req.body.accountId || req.body.acc);
  const fromQuery = req.query && (req.query.accountId || req.query.acc);
  const raw = toSafeString(fromHeader || fromBody || fromQuery);

  if (raw) return raw;
  return fallbackAccountIdFromUser(userId);
}

function getByokKey(req) {
  return toSafeString(req.headers?.["x-openai-key"]);
}

function nextMonthFirstDayTs(now = new Date()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const firstNext = new Date(Date.UTC(y, m + 1, 1, 1, 0, 0, 0));
  return firstNext.getTime();
}

function isSubActive(status) {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "trialing";
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      ensureDirForFile(DB_FILE);
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2), "utf8");
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const db = JSON.parse(raw || "{}");
    if (!db.users || typeof db.users !== "object") db.users = {};
    return db;
  } catch {
    return { users: {} };
  }
}

function writeDB(db) {
  ensureDirForFile(DB_FILE);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function ensureUser(db, accountId) {
  if (!db.users) db.users = {};
  const now = Date.now();

  if (!db.users[accountId]) {
    db.users[accountId] = {
      plan: "FREE",
      usage: { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 },
      createdAt: now,
      updatedAt: now,
      stripe: {
        customerId: null,
        subscriptionId: null,
        status: null,
        email: null,
      },
    };
  }

  const u = db.users[accountId];
  u.updatedAt = now;

  if (!u.usage)
    u.usage = { used: 0, renewAt: nextMonthFirstDayTs(), tokens: 0, lastTs: 0 };
  if (!u.usage.renewAt) u.usage.renewAt = nextMonthFirstDayTs();
  if (typeof u.usage.used !== "number") u.usage.used = 0;
  if (typeof u.usage.tokens !== "number") u.usage.tokens = 0;
  if (typeof u.usage.lastTs !== "number") u.usage.lastTs = 0;

  if (!u.stripe)
    u.stripe = {
      customerId: null,
      subscriptionId: null,
      status: null,
      email: null,
    };

  return u;
}

function maybeResetUsage(u) {
  const now = Date.now();
  const renewAt = Number(u?.usage?.renewAt || 0);
  if (renewAt && now >= renewAt) {
    u.usage.used = 0;
    u.usage.tokens = 0;
    u.usage.lastTs = 0;
    u.usage.renewAt = nextMonthFirstDayTs();
  }
}

function modelSupportsReasoning(modelName) {
  const m = String(modelName || "").toLowerCase();
  return m.startsWith("o1") || m.startsWith("o3") || m.includes("reasoning") || m.startsWith("gpt-5");
}

async function callOpenAI({ apiKey, model, input, maxOut, reasoningEffort }) {
  const url = "https://api.openai.com/v1/responses";

  const payload = {
    model,
    input,
    max_output_tokens: maxOut,
  };

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

  const txt = await r.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`OpenAI non-JSON: ${txt.slice(0, 200)}`);
  }

  if (!r.ok) {
    const msg = json?.error?.message || json?.message || `OpenAI error (${r.status})`;
    const code = json?.error?.code ? ` [${json.error.code}]` : "";
    throw new Error(`${msg}${code}`);
  }

  const outText =
    json.output_text ||
    (Array.isArray(json.output)
      ? json.output
          .map((o) =>
            Array.isArray(o.content)
              ? o.content
                  .filter((c) => c.type === "output_text" && c.text)
                  .map((c) => c.text)
                  .join("")
              : ""
          )
          .join("")
      : "");

  const tokens =
    json?.usage?.total_tokens ??
    Number(json?.usage?.output_tokens || 0) + Number(json?.usage?.input_tokens || 0);

  return { text: String(outText || "").trim(), tokens: Number(tokens || 0), raw: json };
}

function buildPromptFromFields(body) {
  const useCase = toSafeString(body?.useCase);
  const tone = toSafeString(body?.tone);
  const language = toSafeString(body?.language || "DE");
  const topic = toSafeString(body?.topic, 4000);
  const extra = toSafeString(body?.extra, 4000);
  const templateId = toSafeString(body?.templateId || "universal");

  return [
    `Du bist ein Profi-Copywriter & Prompt-Engineer.`,
    `Erstelle einen hochwertigen Output für folgenden Auftrag.`,
    ``,
    `Template: ${templateId}`,
    `UseCase: ${useCase || "-"}`,
    `Ton: ${tone || "-"}`,
    `Sprache: ${language || "-"}`,
    `Thema: ${topic || "-"}`,
    `Zusatz: ${extra || "-"}`,
    ``,
    `Gib nur den finalen Text aus (keine Erklärungen, kein JSON).`,
  ].join("\n");
}

function toStripeId(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "[object Object]") return null;
    return s;
  }
  if (typeof v === "object" && typeof v.id === "string") {
    const s = v.id.trim();
    if (!s || s === "[object Object]") return null;
    return s;
  }
  return null;
}

/* ======================
   3) Middleware
====================== */
app.set("trust proxy", true);

app.use(
  cors({
    origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
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
    optionsSuccessStatus: 204,
  })
);

// Webhook must be RAW. Everything else JSON.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe-webhook") return next();
  express.json({ limit: "1mb" })(req, res, next);
});

/* ======================
   4) Stripe init
====================== */
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ======================
   5) Routes
====================== */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    stripe: !!stripe,
    byokOnly: BYOK_ONLY,
    models: { byok: BYOK_MODEL, pro: PRO_MODEL, boost: BOOST_MODEL },
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    allowedOrigins: ALLOWED_ORIGINS,
    buildTag: BUILD_TAG || null,
    ts: Date.now(),
  });
});

// ✅ Me: NIE wieder 400 wegen accountId – Backend liefert accountId IMMER zurück
app.get("/api/me", (req, res) => {
  const userId = getUserId(req) || `u_${Date.now()}`;
  const accountId = getAccountId(req, userId);

  const db = readDB();
  const u = ensureUser(db, accountId);
  maybeResetUsage(u);
  writeDB(db);

  res.json({
    ok: true,
    userId,
    accountId,
    plan: u.plan,
    usage: u.usage,
    stripe: u.stripe,
    byokOnly: BYOK_ONLY,
    limits: { free: FREE_LIMIT, pro: PRO_LIMIT },
    ts: Date.now(),
  });
});

// BYOK smoke test (accountId tolerant)
app.get("/api/test", async (req, res) => {
  try {
    const userId = getUserId(req) || `u_${Date.now()}`;
    const accountId = getAccountId(req, userId);

    const byokKey = getByokKey(req);
    if (!byokKey) return res.status(400).json({ error: "Missing x-openai-key (BYOK)" });

    const { text, tokens } = await callOpenAI({
      apiKey: byokKey,
      model: BYOK_MODEL,
      input: "Sag genau: OK",
      maxOut: 50,
    });

    res.json({ ok: true, accountId, output: text || "OK", model: BYOK_MODEL, tokens: tokens || 0 });
  } catch (e) {
    res.status(500).json({ error: e?.message || "test_failed" });
  }
});

// Generate (accountId tolerant)
app.post("/api/generate", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-gle-user" });

    const accountId = getAccountId(req, userId);

    const db = readDB();
    const u = ensureUser(db, accountId);
    maybeResetUsage(u);

    const byokKey = getByokKey(req);
    const wantsBoost = String(req.body?.boost || "false").toLowerCase() === "true";

    const isBYOK = !!byokKey;
    const plan = String(u.plan || "FREE").toUpperCase();

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
        return res.status(500).json({ error: "Server OpenAI key missing (SERVER_OPENAI_API_KEY)" });
      }
    }

    const limit = plan === "PRO" ? PRO_LIMIT : FREE_LIMIT;

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

    let modelToUse = isBYOK ? BYOK_MODEL : PRO_MODEL;
    let maxOut = DEFAULT_MAX_OUT;
    let reasoningEffort = null;

    if (wantsBoost) {
      modelToUse = BOOST_MODEL;
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

    u.usage.used += 1;
    u.usage.tokens += Number(tokens || 0);
    u.usage.lastTs = Date.now();
    writeDB(db);

    res.json({
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
        requestId: raw?.id || null,
      },
    });
  } catch (e) {
    console.error("generate error:", e?.message || e);
    res.status(500).json({ error: e?.message || "generate_failed" });
  }
});

/* ======================
   Stripe: Checkout + Portal + Sync + Webhook
====================== */

// ✅ Checkout: NIE wieder 400 wegen fehlendem account header
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });
    if (!STRIPE_PRICE_ID) return res.status(500).json({ error: "stripe_price_missing" });

    const userId = getUserId(req) || `u_${Date.now()}`;
    const accountId = getAccountId(req, userId);

    // 👇 Debug (damit Live Tail etwas zeigt)
    console.log("[checkout] userId=", userId, "accountId=", accountId, "origin=", req.headers?.origin || "-");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/`,
      metadata: { userId, accountId },
      client_reference_id: accountId,
    });

    res.json({ url: session.url, id: session.id, accountId });
  } catch (err) {
    console.error("create-checkout-session error:", err?.message || err);
    res.status(500).json({ error: err?.message || "checkout_failed" });
  }
});

app.post("/api/billing-portal", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });

    const userId = getUserId(req) || `u_${Date.now()}`;
    const accountId = getAccountId(req, userId);

    const db = readDB();
    const u = ensureUser(db, accountId);

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

    res.json({ url: portal.url });
  } catch (e) {
    console.error("billing-portal error:", e?.message || e);
    res.status(500).json({ error: e?.message || "billing_portal_failed" });
  }
});

app.post("/api/sync-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });

    let sessionId = String(req.body?.sessionId || "").trim();
    if (sessionId.includes("#")) sessionId = sessionId.split("#")[0].trim();
    if (!sessionId.startsWith("cs_")) return res.status(400).json({ error: "missing_or_invalid_sessionId" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const userId = getUserId(req) || `u_${Date.now()}`;
    let accountId = getAccountId(req, userId);

    // Wenn Stripe metadata accountId hat, bevorzugen
    const metaAcc = String(session?.metadata?.accountId || "").trim();
    if (metaAcc) accountId = metaAcc;

    const sessionStatus = String(session?.status || "").toLowerCase();
    const paymentStatus = String(session?.payment_status || "").toLowerCase();
    const completed = sessionStatus === "complete" || paymentStatus === "paid";

    const subscriptionId = toStripeId(session?.subscription);
    let customerId = toStripeId(session?.customer);

    if (!completed) {
      return res.status(409).json({
        error: "checkout_not_completed",
        sessionId,
        sessionStatus: session?.status || null,
        paymentStatus: session?.payment_status || null,
        subscriptionId,
        customerId,
      });
    }

    if (!customerId && subscriptionId) {
      const subTmp = await stripe.subscriptions.retrieve(subscriptionId);
      customerId = toStripeId(subTmp?.customer);
    }

    if (!subscriptionId || !customerId) {
      return res.status(409).json({
        error: "checkout_not_completed",
        sessionId,
        subscriptionId,
        customerId,
      });
    }

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const subStatus = String(sub?.status || "").toLowerCase();

    const db = readDB();
    const u = ensureUser(db, accountId);

    u.plan = isSubActive(subStatus) ? "PRO" : "FREE";
    u.stripe.customerId = customerId || null;
    u.stripe.subscriptionId = subscriptionId || null;
    u.stripe.status = subStatus || null;

    writeDB(db);

    res.json({
      ok: true,
      accountId,
      plan: u.plan,
      status: u.stripe.status,
      subscriptionId: u.stripe.subscriptionId,
      customerId: u.stripe.customerId,
    });
  } catch (e) {
    console.error("sync-checkout-session error:", e?.message || e);
    res.status(500).json({ error: e?.message || "sync_failed" });
  }
});

// Stripe webhook (RAW)
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

      const db = readDB();

      async function setProForAccount(accountId, subMaybe, cusMaybe, statusMaybe) {
        if (!accountId) return;
        const u = ensureUser(db, accountId);

        const subId = toStripeId(subMaybe) || toStripeId(u?.stripe?.subscriptionId);
        const cusId = toStripeId(cusMaybe) || toStripeId(u?.stripe?.customerId);

        const st = String(statusMaybe || u?.stripe?.status || "").toLowerCase();
        const active = isSubActive(st);

        u.plan = active ? "PRO" : "FREE";
        u.stripe.subscriptionId = subId || null;
        u.stripe.customerId = cusId || null;
        u.stripe.status = st || null;
      }

      if (type === "checkout.session.completed") {
        const accountId = String(obj?.metadata?.accountId || obj?.client_reference_id || "").trim();
        if (accountId) {
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
          // fallback: match by customerId
          const users = db.users || {};
          const match = Object.keys(users).find((k) => {
            const u = users[k];
            return toStripeId(u?.stripe?.customerId) && cusId && toStripeId(u?.stripe?.customerId) === cusId;
          });
          if (match) await setProForAccount(match, subId, cusId, st);
        }
      }

      writeDB(db);
      res.json({ received: true });
    } catch (e) {
      console.error("webhook error:", e?.message || e);
      res.status(400).send(`Webhook Error: ${e?.message || "unknown"}`);
    }
  }
);

// DEV set plan
app.post("/api/dev/set-plan", (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") return res.status(404).json({ error: "not_found" });

    const token = String(req.headers["x-admin-token"] || "").trim();
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });

    const userId = getUserId(req) || `u_${Date.now()}`;
    const accountId = getAccountId(req, userId);

    const planRaw = String(req.body?.plan || "").toUpperCase().trim();
    const nextPlan = planRaw === "PRO" ? "PRO" : "FREE";

    const db = readDB();
    const u = ensureUser(db, accountId);
    u.plan = nextPlan;
    writeDB(db);

    res.json({ ok: true, accountId, plan: u.plan });
  } catch (e) {
    res.status(500).json({ error: e?.message || "dev_set_plan_failed" });
  }
});

/* ======================
   6) Start
====================== */
app.listen(PORT, HOST, () => {
  console.log(`✅ GLE Backend running on http://${HOST}:${PORT}`);
  console.log(`   FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   BUILD_TAG=${BUILD_TAG || "-"}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(`   Stripe=${!!stripe} Price=${STRIPE_PRICE_ID ? "set" : "missing"}`);
  console.log(`   CORS allowedOrigins=${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`   DB_FILE=${DB_FILE}`);
});
