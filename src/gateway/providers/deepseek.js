"use strict";

const { classifyHttpError, GLEGatewayError } = require("../errors");

async function readJsonResponse(res) {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _text: text };
  }
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: Number(usage.prompt_tokens || 0),
    outputTokens: Number(usage.completion_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    cachedInputTokens: Number(
      usage?.prompt_cache_hit_tokens || usage?.prompt_tokens_details?.cached_tokens || 0,
    ),
  };
}

class DeepSeekProvider {
  constructor({ fetchImpl, baseUrl, apiKey, thinking = "disabled", reasoningEffort = "high" }) {
    this.name = "deepseek";
    this.fetch = fetchImpl;
    this.baseUrl = String(baseUrl || "https://api.deepseek.com").replace(/\/$/, "");
    this.apiKey = String(apiKey || "").trim();
    this.thinking = thinking === "enabled" ? "enabled" : "disabled";
    this.reasoningEffort = reasoningEffort === "max" ? "max" : "high";
  }

  async generate({ apiKeyOverride, model, prompt, temperature, timeoutMs = 90000 }) {
    const apiKey = String(apiKeyOverride || this.apiKey || "").trim();
    if (!apiKey) {
      throw new GLEGatewayError({
        code: "AUTHENTICATION_ERROR",
        message: "DeepSeek API key is not configured.",
        status: 401,
        provider: this.name,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model,
        messages: [
          { role: "system", content: 'Du bist "GLE Prompt Studio". Folge den Regeln im User-Prompt strikt und gib nur den fertigen Output aus.' },
          { role: "user", content: String(prompt || "") },
        ],
        thinking: { type: this.thinking },
      };
      if (this.thinking === "enabled") body.reasoning_effort = this.reasoningEffort;
      else body.temperature = Number.isFinite(temperature) ? temperature : 0.6;

      const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await readJsonResponse(res);
      const providerRequestId = res.headers?.get?.("x-request-id") || data?.id || null;
      if (!res.ok) throw classifyHttpError({ provider: this.name, status: res.status, data, requestId: providerRequestId });

      const output = data?.choices?.[0]?.message?.content;
      if (typeof output !== "string" || !output.trim()) {
        throw new GLEGatewayError({
          code: "INVALID_STRUCTURED_OUTPUT",
          message: "DeepSeek returned no text output.",
          status: 502,
          provider: this.name,
          retryable: true,
          details: { providerRequestId },
        });
      }

      return {
        output: output.trim(),
        providerRequestId,
        usage: normalizeUsage(data.usage),
        rawModel: data.model || model,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new GLEGatewayError({ code: "TIMEOUT", message: "DeepSeek request timed out.", status: 408, provider: this.name, retryable: true, cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { DeepSeekProvider };
