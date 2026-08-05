const assert = require("assert");
const {
  EXECUTION_PIPELINE_VERSION,
  PipelineError,
  normalizePipelineTemplate,
  validatePipelineInput,
  getPipelineSteps,
  getPipelineUsageCost,
  buildPipelineStepExtra,
} = require("../src/execution-pipeline");

assert.equal(EXECUTION_PIPELINE_VERSION, "execution-pipeline-v1.2");

assert.equal(normalizePipelineTemplate("CONTENT_PACK"), "content_pack");
assert.equal(normalizePipelineTemplate("content-pack"), "content_pack");
assert.equal(normalizePipelineTemplate("unknown"), "");

assert.throws(
  () => validatePipelineInput({
    template: "content_pack",
    topic: "",
  }),
  (err) =>
    err instanceof PipelineError &&
    err.code === "missing_topic",
);

assert.throws(
  () => validatePipelineInput({
    template: "unknown",
    topic: "TrailFold 12",
  }),
  (err) =>
    err instanceof PipelineError &&
    err.code === "invalid_pipeline_template",
);

const validated = validatePipelineInput({
  template: "content-pack",
  topic: "TrailFold 12",
  tone: "Professionell",
  outLang: "DE",
  extra: "Ohne Hashtags.",
});

assert.equal(validated.template, "content_pack");
assert.equal(validated.topic, "TrailFold 12");
assert.equal(validated.tone, "Professionell");
assert.equal(validated.outLang, "de");
assert.equal(validated.extra, "Ohne Hashtags.");

const steps = getPipelineSteps(validated.template);

assert.deepEqual(
  steps.map((step) => step.id),
  ["social", "linkedin", "email"],
);

assert.deepEqual(
  steps.map((step) => step.useCase),
  ["Social Media Post", "LinkedIn Post", "E-Mail"],
);

assert.equal(new Set(steps.map((step) => step.id)).size, 3);

assert.equal(getPipelineUsageCost("content_pack"), 3);

const socialExtra = buildPipelineStepExtra({
  step: steps[0],
  extra: "Ohne Hashtags.",
  outLang: "de",
});
assert.ok(socialExtra.includes("Ohne Hashtags."));
assert.ok(socialExtra.includes("exakt 7"));

const linkedInExtra = buildPipelineStepExtra({
  step: steps[1],
  extra: "",
  outLang: "de",
});
assert.ok(linkedInExtra.includes("LinkedIn"));

const emailExtra = buildPipelineStepExtra({
  step: steps[2],
  extra: "",
  outLang: "de",
});
assert.ok(emailExtra.includes("Betreff"));
console.log("GLE execution pipeline test passed");
