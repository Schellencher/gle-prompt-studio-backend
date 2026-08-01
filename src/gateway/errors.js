"use strict";

class GLEGatewayError extends Error {
  constructor({ code, message, status = 500, provider = "unknown", retryable = false, details = null, cause = null }) {
    super(message || code || "Gateway error");
    this.name = "GLEGatewayError";
    this.code = code || "INTERNAL_GATEWAY_ERROR";
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function classifyHttpError({ provider, status, data, requestId }) {
  const rawCode = String(data?.error?.code || data?.code || "").toLowerCase();
  const message = String(
    data?.error?.message || data?.message || data?._text || `${provider}_error_${status}`,
  );

  let code = "PROVIDER_ERROR";
  let retryable = false;

  if (status === 401 || status === 403) code = "AUTHENTICATION_ERROR";
  else if (status === 408) {
    code = "TIMEOUT";
    retryable = true;
  } else if (status === 409) {
    code = "PROVIDER_OVERLOADED";
    retryable = true;
  } else if (status === 429) {
    code = rawCode.includes("billing") || rawCode.includes("quota")
      ? "BILLING_LIMIT_REACHED"
      : "RATE_LIMITED";
    retryable = code === "RATE_LIMITED";
  } else if (status >= 500) {
    code = status === 503 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_OVERLOADED";
    retryable = true;
  } else if (status === 400 || status === 404 || status === 422) {
    if (/context|token.*limit|maximum context/i.test(message)) code = "CONTEXT_LIMIT_EXCEEDED";
    else if (/content|safety|policy|moderation/i.test(message)) code = "CONTENT_REJECTED";
    else if (/model/i.test(message) && /not found|unavailable|does not exist/i.test(message)) code = "MODEL_UNAVAILABLE";
    else code = "INVALID_REQUEST";
  }

  return new GLEGatewayError({
    code,
    message,
    status,
    provider,
    retryable,
    details: { providerRequestId: requestId || null, rawCode: rawCode || null },
  });
}

function toPublicError(error) {
  if (error instanceof GLEGatewayError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      retryable: error.retryable,
      provider: error.provider,
    };
  }
  return {
    ok: false,
    error: "INTERNAL_GATEWAY_ERROR",
    message: String(error?.message || error || "Unknown gateway error"),
    retryable: false,
    provider: "gateway",
  };
}

module.exports = { GLEGatewayError, classifyHttpError, toPublicError };
