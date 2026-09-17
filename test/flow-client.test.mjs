// Regression test for server/flow-client.mjs — the bridge-side Google Flow direct-API
// client. This used to run IN THE BROWSER (extension/src/content/flow-api.js) but
// moved here after a real run hit a bare "Failed to fetch": the sandbox calls carry
// an Authorization header, which disqualifies them from being a CORS-simple request
// regardless of Content-Type, so a real preflight always happens — and when the
// browser's preflight is rejected, fetch() gives page JS zero diagnostic detail.
// ref1's own architecture never does this fetch from the browser either; it harvests
// the session cookie + reCAPTCHA token (the two things that truly need a live tab)
// and does the rest server-side, where Node's fetch has no CORS concept at all.
//
// The endpoint/header/body contract itself is unchanged from before — still verified
// by importing ref2's compiled labs_generate.pyc with Python 3.11 and disassembling
// it (see the header comment in server/flow-client.mjs) — this file just proves the
// Node port sends the exact same requests.

import assert from "node:assert/strict";
import * as flow from "../server/flow-client.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

function jsonResponse(status, body, finalUrl = "") {
  return {
    ok: status < 400,
    status,
    url: finalUrl,
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer,
    body: { cancel: () => {} },
  };
}

function withFetch(impl, fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return impl(String(url), opts);
  };
  return fn(calls).finally(() => { global.fetch = original; });
}

// ---------------------------------------------------------------- session token
console.log("\ngetAccessToken -> GET session with Cookie/User-Agent, reads access_token");
await withFetch(
  async (url) => {
    if (url === "https://labs.google/fx/api/auth/session") return jsonResponse(200, { access_token: "AT123" });
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const token = await flow.getAccessToken("next-auth.session-token=abc123");
    check("returns the access_token", token === "AT123");
    const call = calls[0];
    check("hit the confirmed session URL", call.url === "https://labs.google/fx/api/auth/session");
    check("sends the harvested Cookie header", call.opts.headers.cookie === "next-auth.session-token=abc123");
    check("sends a real Chrome UA (not Node's default)", /Chrome/.test(call.opts.headers["user-agent"]));
  },
);

console.log("\ngetAccessToken -> 401 surfaces as 'cookie rejected', not a generic HTTP error");
await withFetch(
  async () => ({ ok: false, status: 401, url: "", text: async () => "", json: async () => ({}) }),
  async () => {
    await assert.rejects(() => flow.getAccessToken("x=y"), /rejected|signed out|expired/i);
    check("rejects with a clear signed-out message", true);
  },
);

// ---------------------------------------------------------------- create project
console.log("\ncreateProject -> POST trpc createProject, body {json:{projectTitle,toolName}}, Cookie-authed");
await withFetch(
  async (url) => {
    if (url.includes("project.createProject")) return jsonResponse(200, { result: { data: { json: { projectId: "proj-42" } } } });
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const projectId = await flow.createProject("cookie=abc", "BlueSPite");
    check("projectId extracted via deep-find", projectId === "proj-42");
    const call = calls[0];
    check("hit the confirmed trpc URL", call.url === "https://labs.google/fx/api/trpc/project.createProject");
    check("Cookie header sent", call.opts.headers.cookie === "cookie=abc");
    const body = JSON.parse(call.opts.body);
    check("body shape {json:{projectTitle,toolName}}", body.json?.projectTitle === "BlueSPite" && body.json?.toolName === "PINHOLE", JSON.stringify(body));
  },
);

// ---------------------------------------------------------------- upload reference
console.log("\nuploadReferenceImage -> fetch image (plain Node fetch, no CORS), base64, POST /flow/uploadImage");
await withFetch(
  async (url) => {
    if (url === "https://shopee-cdn.example/product.jpg") return jsonResponse(200, {});
    if (url.includes("/flow/uploadImage")) return jsonResponse(200, { media: { name: "media-abc" } });
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const mediaId = await flow.uploadReferenceImage("AT123", "proj-42", "https://shopee-cdn.example/product.jpg");
    check("mediaId returned", mediaId === "media-abc");
    const uploadCall = calls.find((c) => c.url.includes("uploadImage"));
    check("hit SANDBOX_BASE/flow/uploadImage", uploadCall.url === "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage");
    check("Authorization: Bearer <token>", uploadCall.opts.headers.authorization === "Bearer AT123");
    check("Content-Type is text/plain (matches the confirmed-working header)", uploadCall.opts.headers["content-type"] === "text/plain;charset=UTF-8");
    const body = JSON.parse(uploadCall.opts.body);
    check("body has clientContext.projectId + tool + imageBytes (base64)", body.clientContext?.projectId === "proj-42" && body.clientContext?.tool === "PINHOLE" && typeof body.imageBytes === "string", JSON.stringify(body));
  },
);

// ---------------------------------------------------------------- submit R2V
console.log("\nsubmitR2V -> POST batchAsyncGenerateVideoReferenceImages, exact body shape");
await withFetch(
  async (url) => {
    if (url.includes("batchAsyncGenerateVideoReferenceImages")) return jsonResponse(200, { media: [{ name: "pending-media-1" }] });
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const submitted = await flow.submitR2V({
      accessToken: "AT123", projectId: "proj-42", recaptchaToken: "cap-token",
      prompt: "หมอนตุ๊กตาหมี", videoModel: "abra_r2v_10s", aspect: "portrait",
      referenceMediaIds: ["media-abc", "media-def"],
    });
    check("accepted checkpoint returned", submitted.accepted === true && submitted.mediaName === "pending-media-1" && submitted.pendingMediaName === "pending-media-1");
    const call = calls[0];
    check("hit the confirmed R2V endpoint", call.url === "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages");
    const body = JSON.parse(call.opts.body);
    check("mediaGenerationContext.batchId + audioFailurePreference", Boolean(body.mediaGenerationContext?.batchId) && body.mediaGenerationContext?.audioFailurePreference === "BLOCK_SILENCED_VIDEOS");
    check("clientContext.tool=PINHOLE, recaptchaContext.token set", body.clientContext?.tool === "PINHOLE" && body.clientContext?.recaptchaContext?.token === "cap-token");
    const req = body.requests?.[0];
    check("aspectRatio mapped portrait -> VIDEO_ASPECT_RATIO_PORTRAIT", req?.aspectRatio === "VIDEO_ASPECT_RATIO_PORTRAIT");
    check("textInput.structuredPrompt.parts[0].text = prompt", req?.textInput?.structuredPrompt?.parts?.[0]?.text === "หมอนตุ๊กตาหมี");
    check("videoModelKey passed through", req?.videoModelKey === "abra_r2v_10s");
    check("referenceImages has both mediaIds with IMAGE_USAGE_TYPE_ASSET", req?.referenceImages?.length === 2 && req.referenceImages.every((r) => r.imageUsageType === "IMAGE_USAGE_TYPE_ASSET"));
    check("useV2ModelConfig: true", body.useV2ModelConfig === true);
  },
);

// ---------------------------------------------------------------- generate image (I2V step 1)
console.log("\ngenerateImage -> POST flowMedia:batchGenerateImages, exact body shape (I2V start frame)");
await withFetch(
  async (url) => {
    if (url.includes("flowMedia:batchGenerateImages")) {
      return jsonResponse(200, { media: [{ name: "img-media-1", fifeUrl: "https://flow-content.google/signed/frame.png" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const { mediaId, url } = await flow.generateImage({
      accessToken: "AT123", projectId: "proj-42", recaptchaToken: "cap-token",
      prompt: "หมอนตุ๊กตาหมี", aspect: "portrait", model: "NARWHAL",
      referenceMediaIds: ["media-abc"],
    });
    check("mediaId + signed URL returned", mediaId === "img-media-1" && url === "https://flow-content.google/signed/frame.png");
    const call = calls[0];
    check("hit the confirmed per-project image endpoint", call.url === "https://aisandbox-pa.googleapis.com/v1/projects/proj-42/flowMedia:batchGenerateImages");
    const body = JSON.parse(call.opts.body);
    check("top-level clientContext + useNewMedia:true", body.clientContext?.tool === "PINHOLE" && body.useNewMedia === true);
    const req = body.requests?.[0];
    check("imageModelName passed through", req?.imageModelName === "NARWHAL");
    check("imageAspectRatio mapped portrait -> IMAGE_ASPECT_RATIO_PORTRAIT", req?.imageAspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT");
    check("imageInputs uses IMAGE_INPUT_TYPE_REFERENCE + name", req?.imageInputs?.[0]?.imageInputType === "IMAGE_INPUT_TYPE_REFERENCE" && req?.imageInputs?.[0]?.name === "media-abc", JSON.stringify(req?.imageInputs));
  },
);

console.log("\ngenerateImage -> accepted without fifeUrl returns a durable checkpoint for polling");
await withFetch(
  async (url) => jsonResponse(200, { media: [{ name: "img-media-1" }] }),
  async () => {
    const checkpoint = await flow.generateImage({ accessToken: "AT123", projectId: "proj-42", recaptchaToken: "x", prompt: "p", aspect: "portrait", model: "NARWHAL", referenceMediaIds: [] });
    check("returns the pending media id instead of losing accepted work", checkpoint.accepted === true && checkpoint.pendingMediaName === "img-media-1" && checkpoint.url === "");
  },
);

// ---------------------------------------------------------------- I2V video submit
console.log("\nstartVideoFromImage -> POST video:batchAsyncGenerateVideoStartImage, exact body shape");
await withFetch(
  async (url) => {
    if (url.includes("batchAsyncGenerateVideoStartImage")) return jsonResponse(200, { media: [{ name: "pending-i2v-1" }] });
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const submitted = await flow.startVideoFromImage({
      accessToken: "AT123", projectId: "proj-42", recaptchaToken: "cap-token",
      prompt: "หมอนตุ๊กตาหมี", videoModel: "veo_3_1_i2v_lite", aspect: "portrait",
      startImageMediaId: "img-media-1",
    });
    check("accepted checkpoint returned", submitted.accepted === true && submitted.mediaName === "pending-i2v-1");
    const call = calls[0];
    check("hit the confirmed I2V (start-image-only) endpoint", call.url === "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage");
    const body = JSON.parse(call.opts.body);
    const req = body.requests?.[0];
    check("startImage.mediaId set, no endImage (start-only path)", req?.startImage?.mediaId === "img-media-1" && req?.endImage === undefined, JSON.stringify(req));
    check("videoModelKey passed through", req?.videoModelKey === "veo_3_1_i2v_lite");
  },
);

// ---------------------------------------------------------------- poll status
console.log("\npollStatus -> POST batchCheckAsyncVideoGenerationStatus, reads mediaGenerationStatus");
await withFetch(
  (() => {
    let status = "MEDIA_GENERATION_STATUS_PENDING";
    return {
      impl: async (url) => {
        if (url.includes("batchCheckAsyncVideoGenerationStatus")) return jsonResponse(200, { statuses: [{ mediaGenerationStatus: status }] });
        throw new Error(`unexpected fetch ${url}`);
      },
      setStatus: (s) => { status = s; },
    };
  })().impl,
  async (calls) => {
    const pending = await flow.pollStatus("AT123", "proj-42", "pending-media-1");
    check("pending -> done:false", pending.done === false);
    const call = calls.find((c) => c.url.includes("batchCheckAsyncVideoGenerationStatus"));
    check("hit the confirmed poll endpoint", call.url === "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus");
    const body = JSON.parse(call.opts.body);
    check("body shape {media:[{name,projectId}]}", body.media?.[0]?.name === "pending-media-1" && body.media?.[0]?.projectId === "proj-42");
  },
);

console.log("\npollStatus SUCCESS -> done:true");
await withFetch(
  async (url) => jsonResponse(200, { statuses: [{ mediaGenerationStatus: "MEDIA_GENERATION_STATUS_SUCCESSFUL" }] }),
  async () => {
    const res = await flow.pollStatus("AT123", "proj-42", "pending-media-1");
    check("SUCCESS -> done:true", res.done === true);
  },
);

console.log("\npollStatus FAILED -> throws with the RAI filter reason, not a truncated dump");
await withFetch(
  async (url) => jsonResponse(200, {
    remainingCredits: 50,
    media: [{
      name: "08d44b22-9171-4273-9448-abe86acb391a",
      mediaGenerationStatus: "MEDIA_GENERATION_STATUS_FAILED",
      raiMediaFilteredReasons: ["58061214"],
      mediaMetadata: { mediaTitle: "…very long prompt text…".repeat(20) },
    }],
  }),
  async () => {
    await assert.rejects(
      () => flow.pollStatus("AT123", "proj-42", "08d44b22-9171-4273-9448-abe86acb391a"),
      /raiMediaFilteredReasons=58061214/,
    );
    check("surfaces the specific RAI filter code, not a truncated dump", true);
  },
);

// ---------------------------------------------------------------- resolve URL
console.log("\nresolveVideoUrl -> GET media.getMediaUrlRedirect, follows redirect, reads final URL");
await withFetch(
  async (url) => {
    if (url.startsWith("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=")) {
      return jsonResponse(200, {}, "https://flow-content.google/signed/clip-xyz.mp4");
    }
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const url = await flow.resolveVideoUrl("cookie=abc", "pending-media-1");
    check("returns the final signed URL", url === "https://flow-content.google/signed/clip-xyz.mp4");
    const call = calls[0];
    check("media name URL-encoded onto the confirmed endpoint", call.url === "https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=pending-media-1");
    check("Cookie header sent (labs.google endpoint is cookie-authed)", call.opts.headers.cookie === "cookie=abc");
  },
);

// ---------------------------------------------------------------- concat (multi-scene merge)
// concatenate_videos() was disassembled the same way as every other endpoint here — ref2
// does NOT run local ffmpeg for its scene merge, it asks Flow's own server to concat the
// clips. These cases only exercise a done-on-first-poll response so the test doesn't
// actually wait through concatenateVideos()'s real poll interval.
console.log("\nconcatenateVideos -> POST runVideoFxConcatenation, exact body shape, done via encodedVideo");
await withFetch(
  async (url) => {
    if (url.includes(":runVideoFxConcatenation")) return jsonResponse(200, { name: "op-concat-1" });
    if (url.includes(":runVideoFxCheckConcatenationStatus")) return jsonResponse(200, { status: "SUCCEEDED", encodedVideo: "ZmFrZS1tcDQtYnl0ZXM=" });
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const { mediaId, url } = await flow.concatenateVideos({
      accessToken: "AT123", cookieHeader: "cookie=abc",
      mediaIds: ["scene-media-1", "scene-media-2", "scene-media-3"], clipSeconds: 8,
    });
    check("mediaId is the operation name", mediaId === "op-concat-1");
    check("url is a data: URI decoding encodedVideo", url === "data:video/mp4;base64,ZmFrZS1tcDQtYnl0ZXM=");
    const startCall = calls.find((c) => c.url.includes(":runVideoFxConcatenation"));
    check("hit the confirmed concat-start endpoint", startCall.url === "https://aisandbox-pa.googleapis.com/v1:runVideoFxConcatenation");
    const body = JSON.parse(startCall.opts.body);
    check(
      "inputVideos: one entry per scene, in order, length in ns + Xs offsets",
      body.inputVideos?.length === 3
        && body.inputVideos[1].mediaGenerationId === "scene-media-2"
        && body.inputVideos[0].length === String(8 * 1_000_000_000)
        && body.inputVideos[0].startTimeOffset === "0s"
        && body.inputVideos[0].endTimeOffset === "8s",
      JSON.stringify(body.inputVideos),
    );
    const pollCall = calls.find((c) => c.url.includes(":runVideoFxCheckConcatenationStatus"));
    const pollBody = JSON.parse(pollCall.opts.body);
    check("poll body is the double-nested {operation:{operation:{name}}}", pollBody.operation?.operation?.name === "op-concat-1", JSON.stringify(pollBody));
  },
);

console.log("\nconcatenateVideos -> done via mediaGenerationId -> resolves through resolveVideoUrl");
await withFetch(
  async (url) => {
    if (url.includes(":runVideoFxConcatenation")) return jsonResponse(200, { name: "op-concat-2" });
    if (url.includes(":runVideoFxCheckConcatenationStatus")) return jsonResponse(200, { status: "SUCCEEDED", mediaGenerationId: "final-media-9" });
    if (url.startsWith("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=")) return jsonResponse(200, {}, "https://flow-content.google/signed/final.mp4");
    throw new Error(`unexpected fetch ${url}`);
  },
  async (calls) => {
    const { mediaId, url } = await flow.concatenateVideos({
      accessToken: "AT123", cookieHeader: "cookie=abc", mediaIds: ["s1", "s2"], clipSeconds: 8,
    });
    check("mediaId is the resolved media name", mediaId === "final-media-9");
    check("url resolved via getMediaUrlRedirect", url === "https://flow-content.google/signed/final.mp4");
    const resolveCall = calls.find((c) => c.url.includes("getMediaUrlRedirect"));
    check("resolve carries the Cookie header", resolveCall.opts.headers.cookie === "cookie=abc");
  },
);

console.log("\nconcatenateVideos -> done via outputUri (direct URL, no resolve needed)");
await withFetch(
  async (url) => {
    if (url.includes(":runVideoFxConcatenation")) return jsonResponse(200, { name: "op-concat-3" });
    if (url.includes(":runVideoFxCheckConcatenationStatus")) return jsonResponse(200, { status: "SUCCEEDED", outputUri: "https://flow-content.google/signed/direct.mp4" });
    throw new Error(`unexpected fetch ${url}`);
  },
  async () => {
    const { url } = await flow.concatenateVideos({ accessToken: "AT123", cookieHeader: "cookie=abc", mediaIds: ["s1"], clipSeconds: 10 });
    check("url taken straight from outputUri", url === "https://flow-content.google/signed/direct.mp4");
  },
);

console.log("\nconcatenateVideos -> FAIL status throws with the reason, not silently pending");
await withFetch(
  async (url) => {
    if (url.includes(":runVideoFxConcatenation")) return jsonResponse(200, { name: "op-concat-4" });
    if (url.includes(":runVideoFxCheckConcatenationStatus")) return jsonResponse(200, { status: "FAILED", errorMessage: "concat backend error" });
    throw new Error(`unexpected fetch ${url}`);
  },
  async () => {
    await assert.rejects(
      () => flow.concatenateVideos({ accessToken: "AT123", cookieHeader: "cookie=abc", mediaIds: ["s1", "s2"], clipSeconds: 8 }),
      /errorMessage=concat backend error/,
    );
    check("surfaces the failure reason from the poll response", true);
  },
);

console.log("\nconcatenateVideos -> no clip ids at all is a client-side error, no request sent");
await withFetch(
  async (url) => { throw new Error(`should not have fetched ${url}`); },
  async () => {
    await assert.rejects(() => flow.concatenateVideos({ accessToken: "AT123", cookieHeader: "c", mediaIds: [], clipSeconds: 8 }), /ไม่มีคลิปฉากให้ต่อ/);
    check("rejects before making any request", true);
  },
);

console.log("\nconcatenateVideos -> retries the start call once on HTTP 500, then succeeds (real ~3s wait)");
await withFetch(
  (() => {
    let attempts = 0;
    return async (url) => {
      if (url.includes(":runVideoFxConcatenation")) {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 500, url: "", text: async () => "internal error", json: async () => ({}) };
        return jsonResponse(200, { name: "op-concat-5" });
      }
      if (url.includes(":runVideoFxCheckConcatenationStatus")) return jsonResponse(200, { status: "SUCCEEDED", outputUri: "https://flow-content.google/signed/retry.mp4" });
      throw new Error(`unexpected fetch ${url}`);
    };
  })(),
  async () => {
    const { url } = await flow.concatenateVideos({ accessToken: "AT123", cookieHeader: "cookie=abc", mediaIds: ["s1"], clipSeconds: 8 });
    check("succeeds after one HTTP-500 retry", url === "https://flow-content.google/signed/retry.mp4");
  },
);

// ---------------------------------------------------------------- network/CORS-class failure
// The exact bug this whole file exists to fix: a fetch() that never gets a response.
// In the browser this was an undiagnosable "Failed to fetch"; server-side it's a
// plain network error with the SAME step+URL naming as every other traced call.
console.log("\nnetwork failure -> names the step and URL, trace records it");
await withFetch(
  async (url) => { throw new TypeError("fetch failed"); },
  async () => {
    flow.resetTrace();
    await assert.rejects(() => flow.getAccessToken("x=y"), /\[session\].*fetch failed/);
    const trace = flow.currentTrace();
    check("trace records the failed call", trace.some((t) => t.label === "session" && t.ok === false), JSON.stringify(trace));
  },
);

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
