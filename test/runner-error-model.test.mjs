// Regression test for the safety-critical bits of server/runner.mjs's concurrency
// feature: the error classification ported from ref1's bridge/flow-engine.mjs (a
// misclassification either kills a job that should have retried, or silently
// retries something that should have failed loudly) and the CONCURRENT_SAFE_MODELS
// restriction that keeps I2V (which doubles Flow traffic per concurrent slot) out of
// concurrent runs.

import assert from "node:assert/strict";
import { classifyFlowError } from "../server/runner.mjs";
import { FLOW_VIDEO_MODELS, CONCURRENT_SAFE_MODELS } from "../shared/catalog.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

console.log("\nclassifyFlowError -> captcha class");
check("plain 'captcha' mention", classifyFlowError("captcha token invalid") === "captcha");
check("'recaptcha' mention", classifyFlowError("reCAPTCHA verification failed") === "captcha");
check("'unusual activity' (Flow's bot-detection message)", classifyFlowError("blocked: unusual activity detected") === "captcha");
check("bare HTTP 403", classifyFlowError("HTTP 403 (อาจโดน reCAPTCHA บล็อก): forbidden") === "captcha");
check("'permission_denied'", classifyFlowError("permission_denied: access blocked") === "captcha");

console.log("\nclassifyFlowError -> rate-limit class");
check("bare HTTP 429", classifyFlowError("HTTP 429: too many requests") === "rateLimit");
check("'rate limit' phrase", classifyFlowError("you hit the rate limit, slow down") === "rateLimit");
check("'resource_exhausted'", classifyFlowError("RESOURCE_EXHAUSTED: quota") === "rateLimit");

console.log("\nclassifyFlowError -> not retryable, no class");
check("a generic HTTP 500 doesn't match either class", classifyFlowError("HTTP 500: internal error") === null);
check("a missing-field validation error doesn't match either class", classifyFlowError("Flow ไม่คืน media id ของภาพเฟรมแรก") === null);
check("empty message", classifyFlowError("") === null);
check("no message argument at all", classifyFlowError() === null);

// Classified since the shared Flow cookie/access-token cache (runner.mjs's
// getSharedFlowSession/invalidateSharedFlowSession) landed — the cached session is
// now reused across every concurrent job instead of harvested fresh per job, so it
// CAN actually go stale mid-batch. This class doesn't retry the call itself (see
// withFlowErrorModel's header comment), it just drops the cache for the next job.
console.log("\nclassifyFlowError -> session class (drops the shared cookie/token cache, doesn't retry in place)");
check("bare HTTP 401", classifyFlowError("labs.google session expired (HTTP 401) — ล็อกอินใหม่") === "session");
check("'cookie rejected'", classifyFlowError("cookie rejected (signed out or expired)") === "session");
check("'unauthorized'", classifyFlowError("unauthorized: token invalid") === "session");

console.log("\nCONCURRENT_SAFE_MODELS -> only R2V models, none of them I2V");
check("every safe-model id resolves to a real catalog entry", CONCURRENT_SAFE_MODELS.every((id) => FLOW_VIDEO_MODELS.some((m) => m.id === id)), CONCURRENT_SAFE_MODELS.join(","));
check("every safe model is R2V family (no extra generateImage() call)", CONCURRENT_SAFE_MODELS.every((id) => FLOW_VIDEO_MODELS.find((m) => m.id === id)?.family === "r2v"));
check("includes the free Veo Lite model", CONCURRENT_SAFE_MODELS.includes("veo_3_1_r2v_lite_low_priority"));
check("includes all 4 Omni Flash durations", ["abra_r2v_4s", "abra_r2v_6s", "abra_r2v_8s", "abra_r2v_10s"].every((id) => CONCURRENT_SAFE_MODELS.includes(id)));
check("no I2V model slipped in", FLOW_VIDEO_MODELS.filter((m) => m.family === "i2v").every((m) => !CONCURRENT_SAFE_MODELS.includes(m.id)));

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
