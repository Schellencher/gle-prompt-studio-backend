// backend/server.js — GLE Prompt Studio Backend (BYOK + PRO Server-Key, Dev Plan, Quota)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // npm i node-fetch@2
const fs = require("fs");
const path = require("path");

const app = express();

// ===== Config =====
const PORT = Number(process.env.PORT || 3002);

const CORS_ORIGIN = (process.env.CORS_ORIGIN || "http://localhost:3001").trim();
const BYOK_ONLY =
  String(process.env.BYOK_ONLY || "false").toLowerCase() === "true";

const SERVER_OPENAI_API_KEY = (process.env.SERVER_OPENAI_API_KEY || "").trim();
// optional legacy fallback (nicht empfohlen)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const BYOK_MODEL = (
  process.env.BYOK_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-5"
).trim();
const PRO_MODEL = (process.env.PRO_MODEL || "gpt-4o-mini").trim();

const PRO_LIMIT = Number(process.env.PRO_LIMIT || 250);

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "dev-admin").trim();

// ===== Allowed Origins =====
const ALLOWED_ORIGINS = Array.from(
  new Set(
    [
      CORS_ORIGIN,
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ].filter(Boolean)
  )
);

// ===== Middleware =====
app.use(
  cors({
    origin: function (origin, cb) {
      // allow no-origin (curl/postman)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "x-openai-key",
      "x-user-id",
      "x-admin-token",
    ],
  })
);

app.use(express.json({ limit: "1mb" }));

// ===== Small JSON DB (local dev) =====
const DB_FILE = path.join(__dirname, "gle_users.json");

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = { users: {} };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf-8");
      return init;
    }
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { users: {} };
    if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
    return parsed;
  } catch {
    return { users: {} };
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
      plan: "FREE",
      usage: { used: 0, renewAt: nextMonthFirstDayTs() },
      createdAt: new Date().toISOString(),
    };
  }
  // ensure usage block
  if (!db.users[userId].usage)
    db.users[userId].usage = { used: 0, renewAt: nextMonthFirstDayTs() };
  if (typeof db.users[userId].usage.used !== "number")
    db.users[userId].usage.used = 0;
  if (typeof db.users[userId].usage.renewAt !== "number")
    db.users[userId].usage.renewAt = nextMonthFirstDayTs();

  // monthly reset
  const now = Date.now();
  if (now >= db.users[userId].usage.renewAt) {
    db.users[userId].usage.used = 0;
    db.users[userId].usage.renewAt = nextMonthFirstDayTs();
  }
  return db.users[userId];
}

function getUserId(req) {
  const v = (req.headers["x-user-id"] || "").toString().trim();
  return v || "anon";
}

function getApiKeyFromRequest(req) {
  const hdr = req.headers["x-openai-key"];
  if (typeof hdr === "string" && hdr.trim()) return hdr.trim();
  return "";
}

function getAdminToken(req) {
  const t = req.headers["x-admin-token"];
  return typeof t === "string" ? t.trim() : "";
}

// ===== OpenAI helper =====
function extractOutputText(data) {
  if (!data) return "";
  if (typeof data.output_text === "string" && data.output_text.trim())
    return data.output_text;

  const out = data.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const txt = c?.text || c?.value;
          if (typeof txt === "string" && txt.trim()) return txt;
        }
      }
    }
  }
  return "";
}

async function callOpenAI({
  apiKey,
  model,
  system,
  userText,
  maxOutputTokens = 900,
}) {
  const url = "https://api.openai.com/v1/responses";

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    max_output_tokens: maxOutputTokens,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `OpenAI error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.raw = data;
    throw err;
  }

  const text = extractOutputText(data);
  return { data, text };
}

// ===== System Prompt =====
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

// ===== Routes =====
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "GLE Prompt Studio Backend",
    model: BYOK_MODEL,
    byok_only: BYOK_ONLY,
    allowed_origins: ALLOWED_ORIGINS,
  });
});

app.get("/api/me", (req, res) => {
  const db = loadDb();
  const userId = getUserId(req);
  const user = ensureUser(db, userId);
  saveDb(db);

  res.json({
    ok: true,
    user_id: userId,
    plan: user.plan,
    usage: {
      used: user.usage.used,
      limit: PRO_LIMIT,
      renewAt: user.usage.renewAt,
      renewAtISO: new Date(user.usage.renewAt).toISOString(),
    },
    byok_only: BYOK_ONLY,
  });
});

// DEV: plan setzen (lokal)
app.post("/api/dev/set-plan", (req, res) => {
  const token = getAdminToken(req);
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized (admin token)" });
  }

  const db = loadDb();
  const userId =
    (req.body?.userId || getUserId(req) || "").toString().trim() || "anon";
  const planRaw = (req.body?.plan || "").toString().toUpperCase().trim();
  const nextPlan = planRaw === "PRO" ? "PRO" : "FREE";

  const user = ensureUser(db, userId);
  user.plan = nextPlan;

  saveDb(db);

  res.json({ ok: true, user_id: userId, plan: user.plan });
});

// DEV: usage reset (lokal)
app.post("/api/dev/reset-usage", (req, res) => {
  const token = getAdminToken(req);
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized (admin token)" });
  }

  const db = loadDb();
  const userId =
    (req.body?.userId || getUserId(req) || "").toString().trim() || "anon";
  const user = ensureUser(db, userId);

  user.usage.used = 0;
  user.usage.renewAt = nextMonthFirstDayTs();

  saveDb(db);

  res.json({
    ok: true,
    user_id: userId,
    usage: user.usage,
  });
});

// User-Key testen
app.get("/api/test", async (req, res) => {
  const userKey = getApiKeyFromRequest(req);
  if (!userKey) return res.status(400).json({ error: "Missing x-openai-key" });

  try {
    const { data, text } = await callOpenAI({
      apiKey: userKey,
      model: BYOK_MODEL,
      system: "Antworte nur mit 'OK'.",
      userText: "Ping",
      maxOutputTokens: 10,
    });

    return res.json({
      ok: true,
      result: (text || "OK").trim(),
      meta: {
        model: BYOK_MODEL,
        attempts: 1,
        usage: data?.usage || {},
        timestamp: new Date().toISOString(),
      },
    });
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({ error: e.message || "Key test failed" });
  }
});

// Generate
app.post("/api/generate", async (req, res) => {
  const userId = getUserId(req);
  const userKey = getApiKeyFromRequest(req);

  const useCase = (req.body?.useCase || "").toString();
  const tone = (req.body?.tone || "").toString();
  const language = (req.body?.language || "").toString();
  const topic = (req.body?.topic || "").toString();
  const extra = (req.body?.extra || "").toString();

  if (!topic.trim()) return res.status(400).json({ error: "Missing topic" });

  // Decide auth + model
  let apiKeyToUse = "";
  let modelToUse = BYOK_MODEL;
  let usedServerKey = false;

  const db = loadDb();
  const user = ensureUser(db, userId);

  if (BYOK_ONLY) {
    if (!userKey) {
      saveDb(db);
      return res.status(401).json({
        error: "BYOK-only aktiv. Bitte x-openai-key senden.",
      });
    }
    apiKeyToUse = userKey;
    modelToUse = BYOK_MODEL;
  } else {
    if (userKey) {
      apiKeyToUse = userKey;
      modelToUse = BYOK_MODEL;
    } else {
      // no user key -> require PRO
      if (user.plan !== "PRO") {
        saveDb(db);
        return res.status(401).json({
          error: "Kein API-Key. Bitte Key eintragen oder auf PRO upgraden.",
        });
      }

      if (!SERVER_OPENAI_API_KEY) {
        saveDb(db);
        return res.status(500).json({
          error:
            "PRO aktiv, aber SERVER_OPENAI_API_KEY fehlt im Backend (.env).",
        });
      }

      // quota check (server key only)
      if (user.usage.used >= PRO_LIMIT) {
        saveDb(db);
        return res.status(429).json({
          error: `PRO-Limit erreicht (${PRO_LIMIT}/${PRO_LIMIT}). Reset am ${new Date(
            user.usage.renewAt
          ).toLocaleDateString("de-DE")}.`,
        });
      }

      apiKeyToUse = SERVER_OPENAI_API_KEY || OPENAI_API_KEY;
      modelToUse = PRO_MODEL;
      usedServerKey = true;
    }
  }

  const system = buildSystemPrompt();

  const userText = `
USE CASE: ${useCase}
TON: ${tone}
SPRACHE: ${language}

THEMA / KONTEXT:
${topic}

ZUSATZ (optional):
${extra}

WICHTIG:
- Master-Prompt soll zum Use Case passen.
- Output nur als fertiger Prompt.
`.trim();

  try {
    const { data, text } = await callOpenAI({
      apiKey: apiKeyToUse,
      model: modelToUse,
      system,
      userText,
      maxOutputTokens: 1100,
    });

    if (!String(text || "").trim()) {
      throw new Error("OpenAI: Keine Textausgabe erhalten.");
    }

    // increment server usage if server-key used
    if (usedServerKey) {
      user.usage.used += 1;
    }

    saveDb(db);

    return res.json({
      ok: true,
      result: String(text).trim(),
      meta: {
        model: modelToUse,
        attempts: 1,
        usage: data?.usage || {},
        timestamp: new Date().toISOString(),
        server_key_used: usedServerKey,
        plan: user.plan,
      },
    });
  } catch (e) {
    const status = e?.status || 500;
    const msg = e?.message || "Generate failed";
    saveDb(db);
    return res.status(status).json({ error: msg });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ GLE Backend running on http://localhost:${PORT}`);
  console.log(`   BYOK_ONLY=${BYOK_ONLY}`);
  console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
