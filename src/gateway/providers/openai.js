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

function extractResponsesText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content?.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  return "";
}

function normalizeResponsesUsage(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    cachedInputTokens: Number(usage?.input_tokens_details?.cached_tokens || 0),
  };
}

function normalizeChatUsage(usage = {}) {
  return {
    inputTokens: Number(usage.prompt_tokens || 0),
    outputTokens: Number(usage.completion_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    cachedInputTokens: Number(usage?.prompt_tokens_details?.cached_tokens || 0),
  };
}

function safeTemperature(model, temperature, fallback) {
  const normalized = String(model || "").toLowerCase();
  // Preserve the existing backend behavior for GPT-5-family models.
  if (normalized.startsWith("gpt-5")) return undefined;
  if (Number.isFinite(temperature)) return temperature;
  return fallback;
}

class OpenAIProvider {
  constructor({ fetchImpl, baseUrl, apiKey }) {
    this.name = "openai";
    this.fetch = fetchImpl;
    this.baseUrl = String(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = String(apiKey || "").trim();
  }

  async generate({ apiKeyOverride, model, prompt, temperature, timeoutMs = 90000 }) {
    const apiKey = String(apiKeyOverride || this.apiKey || "").trim();
    if (!apiKey) {
      throw new GLEGatewayError({
        code: "AUTHENTICATION_ERROR",
        message: "OpenAI API key is not configured.",
        status: 401,
        provider: this.name,
      });
    }

    try {
      return await this.#responses({ apiKey, model, prompt, temperature, timeoutMs });
    } catch (error) {
      if (error instanceof GLEGatewayError && error.status === 404) {
        return this.#chatCompletions({ apiKey, model, prompt, temperature, timeoutMs });
      }
      throw error;
    }
  }

  async #responses({ apiKey, model, prompt, temperature, timeoutMs }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = { model, input: String(prompt || "") };
      const resolvedTemperature = safeTemperature(model, temperature, undefined);
      if (Number.isFinite(resolvedTemperature)) body.temperature = resolvedTemperature;

      const res = await this.fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await readJsonResponse(res);
      const providerRequestId = res.headers?.get?.("x-request-id") || data?.id || null;
      if (!res.ok) throw classifyHttpError({ provider: this.name, status: res.status, data, requestId: providerRequestId });

      const output = extractResponsesText(data);
      if (!output) {
        throw new GLEGatewayError({
          code: "INVALID_STRUCTURED_OUTPUT",
          message: "OpenAI returned no text output.",
          status: 502,
          provider: this.name,
          retryable: true,
          details: { providerRequestId },
        });
      }
      return { output, providerRequestId, usage: normalizeResponsesUsage(data.usage), rawModel: data.model || model };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new GLEGatewayError({ code: "TIMEOUT", message: "OpenAI request timed out.", status: 408, provider: this.name, retryable: true, cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #chatCompletions({ apiKey, model, prompt, temperature, timeoutMs }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: 'Du bist "GLE Prompt Studio". Folge den Regeln im User-Prompt strikt und gib nur den fertigen Output aus.' },
            { role: "user", content: String(prompt || "") },
          ],
          ...(Number.isFinite(safeTemperature(model, temperature, 0.6))
            ? { temperature: safeTemperature(model, temperature, 0.6) }
            : {}),
        }),
        signal: controller.signal,
      });
      const data = await readJsonResponse(res);
      const providerRequestId = res.headers?.get?.("x-request-id") || data?.id || null;
      if (!res.ok) throw classifyHttpError({ provider: this.name, status: res.status, data, requestId: providerRequestId });

      const output = data?.choices?.[0]?.message?.content;
      if (typeof output !== "string" || !output.trim()) {
        throw new GLEGatewayError({ code: "INVALID_STRUCTURED_OUTPUT", message: "OpenAI returned no text output.", status: 502, provider: this.name, retryable: true });
      }
      return { output: output.trim(), providerRequestId, usage: normalizeChatUsage(data.usage), rawModel: data.model || model };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new GLEGatewayError({ code: "TIMEOUT", message: "OpenAI request timed out.", status: 408, provider: this.name, retryable: true, cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { OpenAIProvider };
