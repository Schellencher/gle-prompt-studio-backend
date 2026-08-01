"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGateway } = require("../src/gateway");

function response({ status = 200, body = {}, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => JSON.stringify(body),
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gle-gateway-"));
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsedBody = JSON.parse(options.body);
    calls.push({ url, body: parsedBody });

    if (url.includes("api.deepseek.com")) {
      return response({
        headers: { "x-request-id": "ds_req_1" },
        body: {
          id: "ds_1",
          model: "deepseek-v4-flash",
          choices: [{ message: { content: "DeepSeek OK" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      });
    }

    return response({
      headers: { "x-request-id": "oa_req_1" },
      body: {
        id: "resp_1",
        model: parsedBody.model || "gpt-test",
        output_text: "OpenAI OK",
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
    });
  };

  const gateway = createGateway({
    fetchImpl,
    dataDir: dir,
    env: {
      OPENAI_API_KEY_SERVER: "test-openai",
      DEEPSEEK_API_KEY: "test-deepseek",
      GLE_FAST_PROVIDER: "deepseek",
      GLE_FAST_MODEL: "deepseek-v4-flash",
      GLE_BALANCED_PROVIDER: "openai",
      GLE_BALANCED_MODEL: "gpt-test",
    },
  });

  const fast = await gateway.generate({
    alias: "gle-fast",
    prompt: "ping",
    requestId: "gle_test_fast",
  });
  assert.equal(fast.output, "DeepSeek OK");
  assert.equal(fast.execution.provider, "deepseek");

  const balanced = await gateway.generate({
    alias: "gle-balanced",
    prompt: "ping",
    requestId: "gle_test_balanced",
  });
  assert.equal(balanced.output, "OpenAI OK");
  assert.equal(balanced.execution.provider, "openai");

  // Preserve the existing backend rule: GPT-5-family requests omit temperature.
  await gateway.generate({
    provider: "openai",
    model: "gpt-5-test",
    prompt: "temperature check",
    temperature: 0.6,
    requestId: "gle_test_gpt5",
  });
  const gpt5Call = calls[calls.length - 1];
  assert.equal(gpt5Call.body.model, "gpt-5-test");
  assert.equal(Object.prototype.hasOwnProperty.call(gpt5Call.body, "temperature"), false);

  const logPath = path.join(dir, "gle-provider-usage.jsonl");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(calls.length, 3);

  const logged = lines.map((line) => JSON.parse(line));
  assert.ok(logged.every((record) => record.promptSha256));
  assert.ok(logged.every((record) => !Object.prototype.hasOwnProperty.call(record, "prompt")));

  console.log("GLE gateway smoke test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
