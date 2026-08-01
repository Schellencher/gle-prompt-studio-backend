"use strict";

const { performance } = require("perf_hooks");
const { OpenAIProvider } = require("./providers/openai");
const { DeepSeekProvider } = require("./providers/deepseek");
const { GatewayLogger, sha256 } = require("./logger");
const { GLEGatewayError, toPublicError } = require("./errors");
const { createRequestId } = require("./request-id");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildAliases(env) {
  return {
    "gle-fast": {
      provider: String(env.GLE_FAST_PROVIDER || "deepseek").toLowerCase(),
      model: String(env.GLE_FAST_MODEL || "deepseek-v4-flash"),
    },
    "gle-balanced": {
      provider: String(env.GLE_BALANCED_PROVIDER || "openai").toLowerCase(),
      model: String(env.GLE_BALANCED_MODEL || env.MODEL_PRO || "gpt-4o"),
    },
    "gle-precision": {
      provider: String(env.GLE_PRECISION_PROVIDER || "openai").toLowerCase(),
      model: String(env.GLE_PRECISION_MODEL || env.MODEL_BOOST || "gpt-4o"),
    },
    "gle-judge": {
      provider: String(env.GLE_JUDGE_PROVIDER || "deepseek").toLowerCase(),
      model: String(env.GLE_JUDGE_MODEL || "deepseek-v4-pro"),
    },
  };
}

function estimateCostEur({ provider, model, usage, env }) {
  const key = `${String(provider).toUpperCase()}_${String(model).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const inputPerMillion = num(env[`${key}_INPUT_EUR_PER_M`], 0);
  const cachedPerMillion = num(env[`${key}_CACHED_INPUT_EUR_PER_M`], inputPerMillion);
  const outputPerMillion = num(env[`${key}_OUTPUT_EUR_PER_M`], 0);

  const cached = Math.min(usage.cachedInputTokens || 0, usage.inputTokens || 0);
  const uncached = Math.max(0, (usage.inputTokens || 0) - cached);
  const amount =
    (uncached / 1_000_000) * inputPerMillion +
    (cached / 1_000_000) * cachedPerMillion +
    ((usage.outputTokens || 0) / 1_000_000) * outputPerMillion;

  return amount > 0 ? Number(amount.toFixed(8)) : null;
}

function createGateway({ fetchImpl, dataDir, env = process.env } = {}) {
  const effectiveFetch = fetchImpl || globalThis.fetch;
  if (typeof effectiveFetch !== "function") {
    throw new GLEGatewayError({
      code: "INTERNAL_GATEWAY_ERROR",
      message: "No fetch implementation is available. Use Node 18+ or pass fetchImpl explicitly.",
      status: 500,
      provider: "gateway",
    });
  }

  const providers = {
    openai: new OpenAIProvider({
      fetchImpl: effectiveFetch,
      baseUrl: env.OPENAI_API_BASE || "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY_SERVER || env.OPENAI_API_KEY || "",
    }),
    deepseek: new DeepSeekProvider({
      fetchImpl: effectiveFetch,
      baseUrl: env.DEEPSEEK_API_BASE || "https://api.deepseek.com",
      apiKey: env.DEEPSEEK_API_KEY || "",
      thinking: env.DEEPSEEK_THINKING || "disabled",
      reasoningEffort: env.DEEPSEEK_REASONING_EFFORT || "high",
    }),
  };

  const aliases = buildAliases(env);
  const logger = new GatewayLogger({ dataDir });

  async function writeLog(record) {
    try {
      await logger.write(record);
    } catch (logError) {
      // Observability must never break a successful generation.
      console.error("GLE gateway log error:", logError?.message || logError);
    }
  }

  async function generate({
    requestId = createRequestId(),
    stage = "generate",
    alias,
    provider,
    model,
    apiKeyOverride,
    prompt,
    temperature,
    timeoutMs = num(env.GLE_PROVIDER_TIMEOUT_MS, 90000),
    metadata = {},
  }) {
    const route = alias ? aliases[alias] : { provider, model };
    const resolvedProvider = String(route?.provider || "").toLowerCase();
    const resolvedModel = String(route?.model || "").trim();
    const adapter = providers[resolvedProvider];

    if (!adapter) {
      throw new GLEGatewayError({
        code: "MODEL_UNAVAILABLE",
        message: `GLE provider '${resolvedProvider || "unknown"}' is not configured.`,
        status: 503,
        provider: "gateway",
      });
    }
    if (!resolvedModel) {
      throw new GLEGatewayError({
        code: "MODEL_UNAVAILABLE",
        message: "No model was selected for this GLE request.",
        status: 503,
        provider: resolvedProvider,
      });
    }

    const callId = createRequestId("call");
    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    try {
      const result = await adapter.generate({
        apiKeyOverride,
        model: resolvedModel,
        prompt,
        temperature,
        timeoutMs,
      });
      const latencyMs = Math.round(performance.now() - t0);
      const estimatedCostEur = estimateCostEur({
        provider: resolvedProvider,
        model: result.rawModel || resolvedModel,
        usage: result.usage,
        env,
      });

      await writeLog({
        requestId,
        callId,
        stage,
        status: "success",
        provider: resolvedProvider,
        modelAlias: alias || null,
        requestedModel: resolvedModel,
        actualModel: result.rawModel || resolvedModel,
        providerRequestId: result.providerRequestId || null,
        startedAt,
        latencyMs,
        usage: result.usage,
        estimatedCostEur,
        currency: "EUR",
        promptSha256: sha256(prompt),
        outputSha256: sha256(result.output),
        metadata,
      });

      return {
        output: result.output,
        execution: {
          requestId,
          callId,
          stage,
          provider: resolvedProvider,
          modelAlias: alias || null,
          model: result.rawModel || resolvedModel,
          providerRequestId: result.providerRequestId || null,
          latencyMs,
          usage: result.usage,
          estimatedCostEur,
          currency: "EUR",
        },
      };
    } catch (error) {
      const normalized = error instanceof GLEGatewayError
        ? error
        : new GLEGatewayError({
            code: "INTERNAL_GATEWAY_ERROR",
            message: String(error?.message || error),
            status: 500,
            provider: resolvedProvider,
            retryable: false,
            cause: error,
          });

      await writeLog({
        requestId,
        callId,
        stage,
        status: "error",
        provider: resolvedProvider,
        modelAlias: alias || null,
        requestedModel: resolvedModel,
        startedAt,
        latencyMs: Math.round(performance.now() - t0),
        error: toPublicError(normalized),
        promptSha256: sha256(prompt),
        metadata,
      });
      throw normalized;
    }
  }

  function health() {
    return {
      aliases,
      providers: {
        openai: { configured: Boolean(providers.openai.apiKey), baseUrl: providers.openai.baseUrl },
        deepseek: { configured: Boolean(providers.deepseek.apiKey), baseUrl: providers.deepseek.baseUrl },
        openrouter: { configured: false, status: "planned" },
      },
      usageLog: "gle-provider-usage.jsonl",
    };
  }

  return { generate, health, aliases };
}

module.exports = { createGateway, createRequestId, GLEGatewayError, toPublicError };
