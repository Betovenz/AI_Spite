// Server-side queue runner for the flow-suite engine — a port of BlueSPite's
// server/runner.mjs, now following its architecture rather than only its spirit.
//
// WHAT CHANGED, AND WHY: this module used to drive one coarse generateFlowMedia()
// call per scene, which spawned the Python bridge (lib/media-core/
// flow_backend_bridge.py -> labs_generate.pyc). That engine has no
// reference-to-video RPC at all, so every R2V model in the catalog was submitted
// through the I2V RPC and came back "MEDIA_GENERATION_STATUS_FAILED —
// failureReasons=NOT_FOUND". The catalog even carried a `family` field for each
// model, copied over from BlueSPite, that nothing here ever read.
//
// The runner now calls Flow directly through ./flow-client.js and mirrors
// BlueSPite step for step:
//
//   * Product storyboards use batchAsyncGenerateVideoReferenceImages with the
//     generated storyboard image as the single IMAGE_USAGE_TYPE_ASSET reference.
//   * One cookie/access-token session is shared by every lane instead of harvested
//     per job; only a session-class error drops it.
//   * Storyboards run in order: image 1 -> video 1 -> image 2 -> video 2 ...
//     and end on one final storyboard image (N videos use N+1 images).
//   * Both text modes generate storyboard images. "ไม่มีข้อความ" only forbids
//     an added ad overlay; it no longer skips the image step.
//   * Jobs can keep the independent storyboard pipeline above, or opt into a
//     two-scene continuous pipeline: scene 1 starts from one storyboard image
//     and scene 2 uses Flow's Extend Video operation from scene 1.
//   * Failure recovery is BlueSPite's two layers: withFlowErrorModel (re-mint a
//     captcha / wait out a rate limit, once) beneath withRoomAutoRecovery (retry
//     in the same Flow room, then open a new room and re-upload references).
//
// Only two things still go through the Chrome extension: harvesting the
// labs.google cookie and minting reCAPTCHA tokens. Both arrive as injected deps.
// Saving the finished clip is unchanged — finalizeScenes still owns the
// product-named file in the Video Library folder and the Final-File-JS metadata.

import { join } from "node:path";
import { ACTION } from "../shared/protocol.mjs";
import * as store from "./store.mjs";
import * as ext from "./ext-link.mjs";
import * as flow from "./flow-client.mjs";
import * as mediaStore from "./media-store.mjs";

// Continuous mode uses the selected video model for Original and every
// Extended hop (Original -> Extended #1 -> Extended #2).
const FLOW_EXTENDED_ENABLED = true;

function usesConsistentCharacter(characterMode) {
  return characterMode === "consistent";
}

let sharedModules = null;
async function loadShared() {
  if (!sharedModules) {
    const [catalog, prompt] = await Promise.all([
      import("../shared/catalog.mjs"),
      import("../shared/prompt.mjs"),
    ]);
    sharedModules = { ...catalog, ...prompt };
  }
  return sharedModules;
}

const GAP_BETWEEN_JOBS_MS = Number(process.env.FLOW_SUITE_JOB_GAP_MS || 8000);
const LANE_STARTUP_STAGGER_MS = Number(process.env.FLOW_SUITE_LANE_STAGGER_MS || 0);
const LANE_IDLE_TIMEOUT_MS = Number(process.env.FLOW_SUITE_LANE_IDLE_MS || 20_000);
const LANE_IDLE_POLL_MS = 1_000;
const RETRY_DELAY_MS = 1000;
const POLL_INTERVAL_MS = Number(process.env.FLOW_SUITE_POLL_MS || 2000);
// A Flow clip can legitimately take minutes.
const POLL_TIMEOUT_MS = 12 * 60 * 1000;
// One step retries in the same Flow room this many times before the room
// fallback opens a fresh project and re-uploads the reference artifacts.
const MAX_RETRIES_PER_STEP = 10;
const MAX_FRESH_ROOMS_PER_JOB = 10;
const STEP_RETRY_DELAY_MS = Number(process.env.FLOW_SUITE_STEP_RETRY_MS || 2000);
const REST_ROOM_MIN_GAP_MS = Number(process.env.FLOW_SUITE_ROOM_MIN_GAP_MS || 4000);
const REST_ROOM_MAX_GAP_MS = Number(process.env.FLOW_SUITE_ROOM_MAX_GAP_MS || 8000);
// A job names its Flow project after its order number (AB-0075-029), so a project
// in the Flow account can be traced straight back to the queue row and the saved
// file. Only work with no order number of its own — the ทดสอบสร้างรูป preview —
// falls back to the app name.
const FLOW_PROJECT_TITLE = "BlueSPite";
const CONTINUOUS_BASE_VIDEO_MODEL = "veo_3_1_r2v_lite";
// Captured from successful fZytfe requests in extended2.har and extended3.har.
// The selected R2V model is valid for the Original clip, while Flow's Extended
// RPC requires this dedicated model key for every continuation hop.
const CONTINUOUS_EXTENDED_VIDEO_MODEL = "veo_3_1_extension_lite_low_priority";
// The "ทดสอบสร้างรูป" button sits outside the lane system, so it keeps its own
// small project cache — without one, every click would litter the Flow account
// with a brand-new project.
const testImageProjectCache = { projectId: null };

function isRecaptchaRejection(message = "") {
  return /\b(?:re)?captcha\b|permission_denied/i.test(message)
    || /recaptcha\s+(evaluation|assessment)\s+failed/i.test(message)
    || /\b403\b[^\n]{0,240}recaptcha/i.test(message)
    || /recaptcha[^\n]{0,240}\b403\b/i.test(message)
    || /unusual activity/i.test(message);
}

const FLOW_QUOTA_ERROR_CODE = "FLOW_USER_QUOTA_REACHED";
const FLOW_FREE_MODEL_CREDIT_WARNING_CODE = "FLOW_FREE_MODEL_CREDIT_WARNING";

function isCreditFreeVideoModel(modelId = "") {
  return String(modelId || "").trim() === "veo_3_1_r2v_lite_low_priority";
}

function isFreeModelCreditWarning(errorOrMessage = "") {
  const code = typeof errorOrMessage === "object" ? String(errorOrMessage?.code || "") : "";
  const message = typeof errorOrMessage === "object"
    ? String(errorOrMessage?.message || errorOrMessage || "")
    : String(errorOrMessage || "");
  return code === FLOW_FREE_MODEL_CREDIT_WARNING_CODE || /FLOW_FREE_MODEL_CREDIT_WARNING/i.test(message);
}

function freeModelCreditWarningError() {
  const error = new Error("FLOW_FREE_MODEL_CREDIT_WARNING: Google Flow แจ้งเครดิตต่ำ แต่โมเดลฟรีจะลองทำงานต่อ");
  error.code = FLOW_FREE_MODEL_CREDIT_WARNING_CODE;
  return error;
}

function isFlowQuotaExhaustion(errorOrMessage = "") {
  const code = typeof errorOrMessage === "object" ? String(errorOrMessage?.code || "") : "";
  const message = typeof errorOrMessage === "object"
    ? String(errorOrMessage?.message || errorOrMessage || "")
    : String(errorOrMessage || "");
  return code === FLOW_QUOTA_ERROR_CODE
    || /PUBLIC_ERROR_USER_QUOTA_REACHED|USER_QUOTA_REACHED|quota (?:reached|exhausted)|insufficient (?:credits?|quota)|โควตา.*หมด/i.test(message);
}

function flowQuotaError() {
  const error = new Error("โควตา Google Flow หมดหรือถึงขีดจำกัดแล้ว — เติมเครดิตหรือรอรอบโควตาใหม่ แล้วกดเริ่มคิวอีกครั้ง");
  error.code = FLOW_QUOTA_ERROR_CODE;
  return error;
}

function classifyFlowError(message = "") {
  if (isFreeModelCreditWarning(message)) return "freeCreditWarning";
  if (isFlowQuotaExhaustion(message)) return "quota";
  if (isRecaptchaRejection(message)) return "captcha";
  if (/\b429\b|rate limit|resource_exhausted/i.test(message)) return "rateLimit";
  if (/unauthori[sz]ed|session expired|access token|\b401\b|cookie rejected/i.test(message)) return "session";
  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("ยกเลิกโดยผู้ใช้"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("ยกเลิกโดยผู้ใช้")); }, { once: true });
  });
}


async function harvestFlowCookies(signal) {
  const result = await ext.command(ACTION.FLOW_HARVEST_COOKIES, {}, 90_000, signal);
  return [result?.cookieHeader].filter(Boolean);
}

async function mintFlowCaptcha(action, projectId, signal) {
  const result = await ext.command(ACTION.FLOW_MINT_CAPTCHA, { action, projectId }, 150_000, signal);
  if (!result?.token) throw new Error("Flow ไม่คืน reCAPTCHA token");
  return result.token;
}

async function refreshFlowCaptcha(projectId, signal) {
  await ext.command(ACTION.FLOW_REFRESH_CAPTCHA, { projectId }, 150_000, signal);
}

async function submitExtendedVideo(payload, signal) {
  return ext.command(ACTION.FLOW_EXTEND_SUBMIT, payload, 120_000, signal);
}

// The standalone app keeps its proven REST room creation path. The embedded
// app optionally creates rooms through the page, then falls back to the same REST API.
const createFlowRoom = null;

function sanitizeStoredUrl(url) {
  return typeof url === "string" && url.startsWith("data:") ? "" : (url || "");
}

async function finalizeScenes({ scenes, orderNumber, model, session, signal, storyboardImages = [] }) {
  if (!scenes.length) throw new Error("ไม่มีคลิปฉากให้บันทึก");
  const paths = mediaStore.orderPaths(orderNumber);
  const sceneFiles = [];
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const entry = { index: index + 1, image: "", video: "" };
    const storyboard = storyboardImages[index];
    if (storyboard?.url) {
      const dest = join(paths.imagesDir, `${orderNumber}-scene-${index + 1}.jpg`);
      try { await mediaStore.downloadToFile(storyboard.url, dest, signal); entry.image = dest; }
      catch (error) { store.log(`บันทึกรูปฉาก ${index + 1} ไม่สำเร็จ: ${error.message}`, "warn"); }
    }
    if (scenes.length > 1 && scene.url) {
      const dest = join(paths.videoDir, `${orderNumber}-scene-${index + 1}.mp4`);
      try { await mediaStore.downloadToFile(scene.url, dest, signal); entry.video = dest; }
      catch (error) { store.log(`บันทึกวิดีโอฉาก ${index + 1} ไม่สำเร็จ: ${error.message}`, "warn"); }
    }
    sceneFiles.push(entry);
  }
  const merged = scenes.length === 1
    ? { mediaId: scenes[0].mediaName, url: scenes[0].url }
    : await flow.concatenateVideos({
        accessToken: session.accessToken,
        cookieHeader: session.cookieHeader,
        mediaIds: scenes.map((scene) => scene.mediaName),
        clipSeconds: model.seconds,
        signal,
      });
  const finalVideoPath = join(paths.videoFinalDir, `${orderNumber}-final.mp4`);
  await mediaStore.downloadToFile(merged.url, finalVideoPath, signal);
  return {
    url: sanitizeStoredUrl(merged.url),
    resultUrl: mediaStore.mediaUrlFor(finalVideoPath),
    finalVideoPath,
    sceneFiles,
  };
}


let draining = false;
let stopRequested = false;
let queueController = null;
const currentJobIds = new Set();
const jobControllers = new Map();

function runnerState() {
  return { draining, stopRequested, currentJobIds: [...currentJobIds] };
}

function cancelJob(jobId) {
  const controller = jobControllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  store.updateJob(jobId, { cancelRequested: true });
  return true;
}

function requestStop() {
  if (!draining) return false;
  stopRequested = true;
  queueController?.abort();
  for (const controller of jobControllers.values()) controller.abort();
  store.log("ขอหยุดคิว — ยกเลิกงานที่กำลังทำอยู่ทันที", "warn");
  return true;
}

function startQueue(onChange = () => {}) {
  if (draining) return false;
  draining = true;
  stopRequested = false;
  queueController = new AbortController();
  const concurrency = Math.min(150, Math.max(1, Number(store.settings().concurrency) || 1));
  store.log(`เริ่มรันคิว (${concurrency} คิวพร้อมกัน)`);
  onChange();
  const lanes = Array.from({ length: concurrency }, (_, i) => runLane(onChange, i));
  Promise.allSettled(lanes).then((results) => {
    for (const r of results) if (r.status === "rejected") store.log(`คิวหยุดเพราะข้อผิดพลาด: ${r.reason?.message}`, "error");
  }).finally(() => {
    draining = false;
    stopRequested = false;
    queueController = null;
    currentJobIds.clear();
    store.log("หยุดคิวแล้ว", "warn");
    onChange();
  });
  return true;
}

function failedJobIds(requestedIds = null) {
  const requested = Array.isArray(requestedIds) && requestedIds.length ? new Set(requestedIds.map(String)) : null;
  return store.jobs()
    .filter((job) => job.status === "failed" && (!requested || requested.has(String(job.id))))
    .map((job) => job.id);
}

/** Requeue failed work and ensure a lane is available in one atomic command.
 * If the runner is still in its idle-drain window after a failure, startQueue
 * intentionally returns false; that existing lane will claim the requeued job. */
function retryFailedJobs(requestedIds = null, onChange = () => {}) {
  const retried = failedJobIds(requestedIds);
  for (const jobId of retried) {
    store.updateJob(jobId, {
      status: "queued",
      error: "",
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
    });
  }
  const started = retried.length ? startQueue(onChange) : false;
  onChange();
  return {
    retried,
    started,
    alreadyRunning: !started && draining && !stopRequested,
    runner: runnerState(),
  };
}

/** The main Run button also acts as "retry failed" when failed rows are the
 * only work on the page. This matches what the operator sees and prevents a
 * successful click from starting an empty 20-second idle drain. */
function startQueueWithFailedFallback(onChange = () => {}) {
  let retried = [];
  const hasQueued = store.jobs().some((job) => job.status === "queued");
  if (!hasQueued && !currentJobIds.size && !stopRequested) {
    retried = failedJobIds();
    for (const jobId of retried) {
      store.updateJob(jobId, {
        status: "queued",
        error: "",
        cancelRequested: false,
        startedAt: null,
        finishedAt: null,
      });
    }
  }
  const queued = store.jobs().some((job) => job.status === "queued");
  const started = queued ? startQueue(onChange) : false;
  onChange();
  return {
    retried,
    started,
    alreadyRunning: !started && draining && !stopRequested,
    noWork: !queued,
    runner: runnerState(),
  };
}

function claimNextQueued() {
  const all = store.jobs();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].status === "queued") {
      const job = all[i];
      store.updateJob(job.id, { status: "running", error: "", startedAt: Date.now() });
      return store.job(job.id);
    }
  }
  return null;
}

function recordJobHistory(job) {
  if (!job?.orderNumber) return;
  const sceneMode = FLOW_EXTENDED_ENABLED && job.sceneMode === "continuous" ? "continuous" : "independent";
  const productImage = job.productImage || job.product?.images?.find(Boolean) || job.thumb || "";
  store.recordHistory({
    id: job.id, jobId: job.id, platform: job.platform, productId: job.productId,
    orderNumber: job.orderNumber, title: job.title, productImage, thumb: productImage,
    textMode: job.textMode, characterMode: job.characterMode === "consistent" ? "consistent" : "random", sceneMode,
    videoModel: job.videoModel,
    extendedVideoModel: sceneMode === "continuous"
      ? (job.extendedVideoModel || CONTINUOUS_EXTENDED_VIDEO_MODEL)
      : "",
    sceneCount: job.sceneCount, status: job.status,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    finalVideoUrl: job.finalVideoUrl, videoUrl: job.videoUrl,
    error: job.error || "",
  });
}

async function runLane(onChange, laneIndex) {
  if (laneIndex > 0) await sleep(laneIndex * LANE_STARTUP_STAGGER_MS, queueController?.signal).catch(() => {});
  let first = true;
  let idleSince = null;
  for (;;) {
    if (stopRequested) break;
    const hasQueuedJob = store.jobs().some((item) => item.status === "queued");
    if (!hasQueuedJob) {
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= LANE_IDLE_TIMEOUT_MS) break;
      try { await sleep(LANE_IDLE_POLL_MS, queueController?.signal); }
      catch { break; }
      continue;
    }
    idleSince = null;
    if (!first) {
      try { await sleep(GAP_BETWEEN_JOBS_MS, queueController?.signal); }
      catch { break; }
      if (stopRequested) break;
    }

    // Claim only after the inter-job pause. Claiming before the pause left a
    // job orphaned as `running` when Stop aborted the pause.
    const job = claimNextQueued();
    if (!job) continue;
    first = false;

    currentJobIds.add(job.id);
    const controller = new AbortController();
    jobControllers.set(job.id, controller);
    store.log(`เริ่มงาน: ${job.title || job.id}`, "info", { stage: "job.started", videoModel: job.videoModel });
    onChange();
    try {
      const result = await runJob(job, controller.signal, onChange);
      const finished = store.updateJob(job.id, { status: "done", ...result, finishedAt: Date.now() });
      recordJobHistory(finished);
      store.log(`เสร็จ: ${job.title || job.id}`, "info", { stage: "job.done", videoUrl: result.videoUrl });
    } catch (err) {
      const cancelled = /ยกเลิกโดยผู้ใช้|cancelled/i.test(err.message || "");
      const quotaReached = isFlowQuotaExhaustion(err);
      if (quotaReached) {
        stopRequested = true;
        queueController?.abort();
        for (const [otherJobId, otherController] of jobControllers) {
          if (otherJobId !== job.id) otherController.abort();
        }
        store.log("หยุดคิวอัตโนมัติ: โควตา Google Flow หมด — งานที่ยังไม่เริ่มจะคงอยู่ในคิว", "error", {
          stage: "queue.quota-paused",
        });
      }
      const displayError = quotaReached ? flowQuotaError().message : err.message;
      const finished = store.updateJob(job.id, {
        status: cancelled ? "cancelled" : "failed",
        error: displayError,
        finishedAt: Date.now(),
      });
      recordJobHistory(finished);
      store.log(`${cancelled ? "ยกเลิก" : "ล้มเหลว"}: ${job.title || job.id} — ${displayError}`, cancelled ? "warn" : "error", {
        stage: cancelled ? "job.cancelled" : "job.failed",
      });
    }
    jobControllers.delete(job.id);
    currentJobIds.delete(job.id);
    onChange();
  }
}

// ------------------------------------------------------------------ Flow session
// One cookie harvest + access token shared by every lane. Harvesting per job
// meant `concurrency` simultaneous requests against the one shared Flow tab,
// which is what the queue's pile-up of timeouts at concurrency 10 was. Only a
// session-class error drops the cache, so the next job re-harvests.
let sharedSession = null;
let sessionRefresh = null;
let restRoomTail = Promise.resolve();
let lastRestRoomAt = 0;

function invalidateSharedFlowSession() { sharedSession = null; }

async function harvestFlowSession(signal) {
  const candidates = await harvestFlowCookies(signal);
  if (!candidates.length) throw new Error("BlueSPite Extension ยังอ่านคุกกี้ Google Labs ไม่ได้ — เปิด Flow แล้วล็อกอินก่อน");
  // Same order the Python bridge used: the combined labs+google-sso cookie
  // first, then the labs-only one, because the richer cookie can be present
  // and still be rejected.
  let lastError = null;
  for (const cookieHeader of candidates) {
    try {
      return { cookieHeader, accessToken: await flow.getAccessToken(cookieHeader, signal) };
    } catch (err) {
      lastError = err;
      store.log(`ขอ access token ด้วยคุกกี้ชุดหนึ่งไม่สำเร็จ — ${err.message}`, "warn");
    }
  }
  throw lastError || new Error("ขอ access token ของ Google Labs ไม่สำเร็จ");
}

async function getSharedFlowSession(signal) {
  if (sharedSession) return sharedSession;
  if (!sessionRefresh) {
    sessionRefresh = harvestFlowSession(signal)
      .then((session) => { sharedSession = session; return session; })
      .finally(() => { sessionRefresh = null; });
  }
  return sessionRefresh;
}

async function refreshRunnerSession(session, signal) {
  invalidateSharedFlowSession();
  const fresh = await getSharedFlowSession(signal);
  session.accessToken = fresh.accessToken;
  session.cookieHeader = fresh.cookieHeader;
  return session;
}

async function createRestRoomThrottled(cookieHeader, title, signal) {
  const operation = restRoomTail.then(async () => {
    const randomGap = REST_ROOM_MIN_GAP_MS
      + Math.floor(Math.random() * Math.max(1, REST_ROOM_MAX_GAP_MS - REST_ROOM_MIN_GAP_MS + 1));
    const waitMs = Math.max(0, lastRestRoomAt + randomGap - Date.now());
    if (waitMs) await sleep(waitMs, signal);
    const projectId = await flow.createProject(cookieHeader, title, signal);
    lastRestRoomAt = Date.now();
    return projectId;
  });
  restRoomTail = operation.catch(() => {});
  return operation;
}

async function createProjectPreferred(cookieHeader, title, signal) {
  if (typeof createFlowRoom === "function") {
    try {
      const projectId = String(await createFlowRoom(title, signal) || "").trim();
      if (projectId) return projectId;
    } catch (error) {
      store.log(`สร้างห้องผ่านหน้า Flow ไม่สำเร็จ — ใช้ REST สำรอง: ${error.message}`, "warn");
    }
  }
  return createRestRoomThrottled(cookieHeader, title, signal);
}

/** `projectCache` is a {projectId} box owned by one job — the session is shared,
 *  the Flow room is not, so one job's room switch never disturbs another lane. */
async function ensureFlowSession(projectCache, signal) {
  let session = await getSharedFlowSession(signal);
  const projectTitle = projectCache.title || FLOW_PROJECT_TITLE;
  if (!projectCache.projectId) {
    try {
      projectCache.projectId = await createProjectPreferred(session.cookieHeader, projectTitle, signal);
    } catch (err) {
      // The session is cached across jobs, so it CAN go stale between them —
      // and createProject is the first call every job makes, so that is where
      // it surfaces. Nothing used to classify this error (withFlowErrorModel
      // only wraps the generate calls), so every job kept reusing the same
      // dead token and failed instantly with "create project HTTP 401".
      if (classifyFlowError(err.message) !== "session") throw err;
      store.log("session/cookie ของ Flow หมดอายุ — ขอใหม่แล้วลองอีกครั้ง", "warn");
      // Only drop the entry WE used: with several lanes failing at once, a
      // lane must not throw away a fresh session another lane just fetched.
      if (sharedSession === session) invalidateSharedFlowSession();
      session = await getSharedFlowSession(signal);
      projectCache.projectId = await createProjectPreferred(session.cookieHeader, projectTitle, signal);
    }
    store.log(`สร้างโปรเจกต์ Flow ใหม่: ${projectTitle} (${projectCache.projectId})`);
  }
  // projectTitle rides along so a room switch names the new room the same.
  return {
    accessToken: session.accessToken,
    cookieHeader: session.cookieHeader,
    projectId: projectCache.projectId,
    projectTitle,
    freshRooms: 0,
  };
}

/** Mirror flow-client's per-request trace into the queue log, so the Log panel
 *  shows the exact RPC sequence the way BlueSPite's does. */
function reportFlowTrace() {
  for (const entry of flow.currentTrace()) {
    const ms = entry.ms != null ? ` (${entry.ms}ms)` : "";
    const tag = entry.label ? `[${entry.label}] ` : "";
    if (entry.ok) store.log(`${tag}✓ ${entry.url}${ms}`, "debug");
    // A non-2xx response carries a status but no `error` string, so print
    // whichever the entry actually has instead of a bare "undefined".
    else store.log(`${tag}✗ ${entry.url}${ms} — ${entry.error || `HTTP ${entry.status}`}`, "error");
  }
  flow.resetTrace();
}

// ------------------------------------------------------------------ retry model
/** Run `attempt(captchaToken)` with a freshly minted captcha; recover captcha,
 *  rate-limit, and session failures once before returning control upstairs. */
async function withFlowErrorModel(captchaAction, session, attempt, label, signal, options = {}) {
  const creditFreeVideo = isCreditFreeVideoModel(options.videoModel);
  let captcha = await mintFlowCaptcha(captchaAction, session.projectId, signal);
  try {
    return await attempt(captcha);
  } catch (err) {
    const cls = classifyFlowError(err.message);
    if (cls === "quota" && !creditFreeVideo) throw flowQuotaError();
    if ((cls === "quota" || cls === "freeCreditWarning") && creditFreeVideo) {
      store.log(`${label}: Flow แจ้งเครดิตต่ำ แต่ ${options.videoModel} เป็นโมเดลฟรี — ลองทำงานต่อ`, "warn", {
        stage: "video.free-credit-warning",
        videoModel: options.videoModel,
      });
      await sleep(RETRY_DELAY_MS, signal);
      captcha = await mintFlowCaptcha(captchaAction, session.projectId, signal);
      try {
        return await attempt(captcha);
      } catch (retryError) {
        const retryClass = classifyFlowError(retryError.message);
        if (retryClass === "quota" || retryClass === "freeCreditWarning") throw freeModelCreditWarningError();
        throw retryError;
      }
    }
    if (cls === "session") {
      store.log(`${label}: session/cookie หมดอายุ — ขอ session ใหม่แล้วลองอีกครั้ง`, "warn");
      await refreshRunnerSession(session, signal);
      captcha = await mintFlowCaptcha(captchaAction, session.projectId, signal);
      return attempt(captcha);
    }
    if (!cls) throw err;
    if (cls === "captcha") {
      store.log(`${label}: เจอ captcha/unusual-activity — refresh หน้า Flow แล้วขอ captcha ใหม่`, "warn");
      await refreshFlowCaptcha(session.projectId, signal);
      captcha = await mintFlowCaptcha(captchaAction, session.projectId, signal);
    } else {
      store.log(`${label}: โดน rate limit — รอแล้วลองอีกครั้ง`, "warn");
      await sleep(RETRY_DELAY_MS, signal);
    }
    return await attempt(captcha);
  }
}

/** Same model for the captcha-less calls — poll and concat. */
async function withRateLimitRetry(attempt, label, signal) {
  try {
    return await attempt();
  } catch (err) {
    const cls = classifyFlowError(err.message);
    if (cls === "session") invalidateSharedFlowSession();
    if (cls !== "rateLimit") throw err;
    store.log(`${label}: โดน rate limit — รอแล้วลองอีกครั้ง`, "warn");
    await sleep(RETRY_DELAY_MS, signal);
    return await attempt();
  }
}

async function openNewFlowRoom(session, label, signal) {
  if (session.freshRooms >= MAX_FRESH_ROOMS_PER_JOB) {
    throw new Error(`${label}: ใช้ห้อง Flow สำรองครบ ${MAX_FRESH_ROOMS_PER_JOB} ห้องแล้ว`);
  }
  session.projectId = await createProjectPreferred(session.cookieHeader, session.projectTitle || FLOW_PROJECT_TITLE, signal);
  session.freshRooms += 1;
  store.log(`${label}: เปิดห้อง Flow ใหม่ (fallback หลัง retry ในห้องเดิมครบ) — ${session.projectId}`, "warn");
  return session.projectId;
}

/** Sits above withFlowErrorModel: one step retries in the SAME Flow room up to
 *  MAX_RETRIES_PER_STEP - 1 times, then opens a fresh room and lets
 *  `onRoomSwitch` re-upload whatever artifact the next attempt needs (mediaIds
 *  from the old room are invalid in the new one). Only an abort stops it. */
async function withRoomAutoRecovery(session, label, signal, attempt, onRoomSwitch) {
  let attemptsInRoom = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (signal?.aborted || /ยกเลิก|cancelled/i.test(err.message)) throw err;
      if (isFlowQuotaExhaustion(err)) throw flowQuotaError();
      // Once Flow accepted a media checkpoint, an ambiguous timeout/network
      // failure must only be reconciled by polling that same checkpoint. Never
      // switch room or resubmit it because that can spend credits twice.
      if (err.acceptedCheckpoint || err.code === "FLOW_ACCEPTED_UNRESOLVED") throw err;
      if (attemptsInRoom < MAX_RETRIES_PER_STEP - 1) {
        attemptsInRoom += 1;
        store.log(`${label}: ล้มเหลวในห้องเดิม (${attemptsInRoom}/${MAX_RETRIES_PER_STEP - 1}) — ${err.message}`, "warn");
        await sleep(STEP_RETRY_DELAY_MS * attemptsInRoom, signal);
        continue;
      }
      await openNewFlowRoom(session, label, signal);
      if (onRoomSwitch) await onRoomSwitch();
      attemptsInRoom = 0;
    }
  }
}

async function uploadReferences(accessToken, projectId, urls, label, signal) {
  if (label) store.log(`${label}อัปโหลดรูปอ้างอิง ${urls.length} รูป`);
  const mediaIds = [];
  for (const url of urls) mediaIds.push(await flow.uploadReferenceImage(accessToken, projectId, url, signal));
  return mediaIds;
}

// ------------------------------------------------------------------ poll
async function pollUntilDone({ session, projectId, mediaName }, job, onChange, label, signal) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let ticks = 0;
  while (Date.now() < deadline) {
    if (stopRequested) throw new Error("ยกเลิกโดยผู้ใช้");
    await sleep(POLL_INTERVAL_MS, signal);
    ticks += 1;
    let status;
    try {
      status = await withRateLimitRetry(
        () => flow.pollStatus(session.accessToken, projectId, mediaName, signal),
        label,
        signal,
      );
    } catch (error) {
      if (definitiveGenerationFailure(error)) throw error;
      if (classifyFlowError(error.message) === "session") {
        store.log(`${label}: session หมดอายุระหว่างรอ — เชื่อมใหม่แล้วรอ checkpoint เดิม`, "warn");
        await refreshRunnerSession(session, signal);
        continue;
      }
      store.log(`${label}: ตรวจสถานะยังไม่ได้ — รอ checkpoint เดิมต่อ`, "warn");
      continue;
    }
    if (status.done) {
      try {
        return await flow.resolveVideoUrl(session.cookieHeader, mediaName, signal);
      } catch (error) {
        if (classifyFlowError(error.message) === "session") await refreshRunnerSession(session, signal);
        store.log(`${label}: วิดีโอเสร็จแล้ว กำลังรอ URL ดาวน์โหลด`, "info");
        continue;
      }
    }
    if (ticks % 5 === 0) {
      store.log(`${label}: รออยู่ ${Math.round(ticks * POLL_INTERVAL_MS / 1000)}s…`);
      reportFlowTrace();
      onChange();
    }
  }
  const error = new Error("รอผลวิดีโอจาก Flow นานเกินกำหนด แต่ระบบรับงานแล้ว — จะไม่ส่งงานซ้ำ");
  error.code = "FLOW_ACCEPTED_UNRESOLVED";
  error.acceptedCheckpoint = true;
  throw error;
}

function currentCheckpoints(job) {
  return store.job(job.id)?.flowCheckpoints || job.flowCheckpoints || {};
}

function readCheckpoint(job, kind, sceneIndex) {
  return currentCheckpoints(job)?.[kind]?.[String(sceneIndex)] || null;
}

function writeCheckpoint(job, kind, sceneIndex, checkpoint) {
  const all = currentCheckpoints(job);
  const group = { ...(all[kind] || {}) };
  if (checkpoint) group[String(sceneIndex)] = checkpoint;
  else delete group[String(sceneIndex)];
  store.updateJob(job.id, { flowCheckpoints: { ...all, [kind]: group } });
  // Accepted checkpoints must reach disk before the first poll, otherwise a
  // process crash in the debounce window could cause a charged resubmit.
  store.flushNow();
}

function persistRoom(job, session) {
  store.updateJob(job.id, { flowProjectId: session.projectId });
  store.flushNow();
}

function definitiveGenerationFailure(error) {
  return /MEDIA_GENERATION_STATUS_(FAILED|ERROR)|Flow แจ้งว่างานล้มเหลว/i.test(String(error?.message || error));
}

function nextSeed() {
  return Math.floor(Math.random() * 1_000_000);
}

async function runCharacterReference({ job, shared, session, signal }, onChange) {
  const label = `${job.title}: ภาพตัวละครอ้างอิง`;
  const imageModelId = job.imageModel || shared.DEFAULT_IMAGE_MODEL;
  let checkpoint = readCheckpoint(job, "characters", 0);
  if (checkpoint?.url) {
    let mediaId = checkpoint.mediaId || checkpoint.pendingMediaName || "";
    if (checkpoint.projectId !== session.projectId || !mediaId) {
      mediaId = await flow.uploadReferenceImage(session.accessToken, session.projectId, checkpoint.url, signal);
    }
    const restored = { ...checkpoint, mediaId, pendingMediaName: mediaId, projectId: session.projectId };
    writeCheckpoint(job, "characters", 0, restored);
    store.updateJob(job.id, { characterImageUrl: restored.url, characterMediaId: mediaId });
    return restored;
  }

  let imageSeed = Number.isInteger(Number(checkpoint?.seed)) ? Number(checkpoint.seed) : nextSeed();
  const prompt = shared.buildCharacterPrompt({ direction: job.direction || {} });
  store.log(`${label}: กำลังสร้างด้วย ${imageModelId}`, "info", { stage: "character.started" });
  const image = await withRoomAutoRecovery(session, label, signal, async () => {
    if (!checkpoint?.pendingMediaName && !checkpoint?.mediaId) {
      const submitted = await withFlowErrorModel(flow.RECAPTCHA_ACTION_IMAGE, session, (captcha) => flow.generateImage({
        accessToken: session.accessToken, projectId: session.projectId, recaptchaToken: captcha,
        prompt, aspect: job.aspect || "portrait", model: imageModelId,
        referenceMediaIds: [], seed: imageSeed, signal,
      }), label, signal);
      checkpoint = { ...submitted, projectId: session.projectId, seed: submitted.seed ?? imageSeed, acceptedAt: Date.now() };
      writeCheckpoint(job, "characters", 0, checkpoint);
      store.log(`${label}: Flow รับงานแล้ว`, "info", { stage: "character.accepted" });
    }
    if (checkpoint.url) return checkpoint;
    try {
      return await flow.pollImageResult({ cookieHeader: session.cookieHeader, checkpoint, signal });
    } catch (error) {
      if (classifyFlowError(error.message) === "session") {
        await refreshRunnerSession(session, signal);
        return flow.pollImageResult({ cookieHeader: session.cookieHeader, checkpoint, signal });
      }
      error.acceptedCheckpoint = true;
      throw error;
    }
  }, async () => {
    checkpoint = null;
    imageSeed = nextSeed();
    writeCheckpoint(job, "characters", 0, null);
    persistRoom(job, session);
  });

  checkpoint = { ...image, projectId: session.projectId, completedAt: Date.now() };
  writeCheckpoint(job, "characters", 0, checkpoint);
  const mediaId = checkpoint.mediaId || checkpoint.pendingMediaName || "";
  if (!checkpoint.url || !mediaId) throw new Error("Flow ไม่คืนรูปหรือ mediaId ของตัวละครอ้างอิง");
  store.updateJob(job.id, { characterImageUrl: checkpoint.url, characterMediaId: mediaId });
  store.log(`${label}: สร้างสำเร็จ`, "info", { stage: "character.completed", mediaId });
  onChange();
  return { ...checkpoint, mediaId };
}

async function restoreStoryboardReferences(session, productImages, characterImageUrl, label, signal) {
  session.mediaIds = await uploadReferences(session.accessToken, session.projectId, productImages, label, signal);
  session.productMediaProjectId = session.projectId;
  let characterMediaId = "";
  if (characterImageUrl) {
    characterMediaId = await flow.uploadReferenceImage(session.accessToken, session.projectId, characterImageUrl, signal);
  }
  session.characterMediaId = characterMediaId;
  session.storyboardMediaIds = [characterMediaId, ...session.mediaIds].filter(Boolean);
  return session.storyboardMediaIds;
}

// ------------------------------------------------------------------ image
/** Generate one storyboard image. Both text modes use this step; noText only
 *  changes the prompt so no ad overlay is added. An accepted image checkpoint
 *  is persisted before polling and is never resubmitted on an ambiguous error. */
async function runSceneImage({ job, shared, model, textMode, referenceImages, sceneIndex, sceneCount, session, signal, state }, onChange) {
  const storyboardCount = sceneCount + 1;
  const label = `${job.title} [ภาพ ${sceneIndex + 1}/${storyboardCount}]`;

  // Fresh buildPrompt() per scene so the random background/camera pick varies
  // scene to scene, cached on `state` so phase 2 reuses THIS scene's video
  // prompt instead of re-rolling a different one.
  state.prompts = shared.buildPrompt({
    product: job.product || {}, direction: job.direction || {},
    videoModel: job.videoModel, extraPrompt: job.extraPrompt || "", textMode,
  });
  if (session.characterMediaId) {
    state.prompts.imagePrompt += "\n\nCHARACTER IDENTITY — STRICT: The first reference image is the approved character identity. Reproduce exactly the same adult person in this scene: same face, hairstyle, apparent age, body proportions, and clothing. The remaining reference image is the real product and must remain exact.";
  }
  if (sceneIndex === 0) store.updateJob(job.id, { prompts: state.prompts });

  const imageModelId = job.imageModel || shared.DEFAULT_IMAGE_MODEL;
  let checkpoint = readCheckpoint(job, "images", sceneIndex);
  if (checkpoint?.url) {
    state.imageUrl = checkpoint.url;
    state.startImageMediaId = checkpoint.mediaId || checkpoint.pendingMediaName;
    return;
  }
  let imageSeed = Number.isInteger(Number(checkpoint?.seed)) ? Number(checkpoint.seed) : nextSeed();
  store.log(`${label}: สร้าง Storyboard (${imageModelId})`, "info", { stage: "image.started", scene: sceneIndex + 1 });
  const image = await withRoomAutoRecovery(session, label, signal, async () => {
    if (!checkpoint?.pendingMediaName && !checkpoint?.mediaId) {
      const submitted = await withFlowErrorModel(flow.RECAPTCHA_ACTION_IMAGE, session, (captcha) => flow.generateImage({
        accessToken: session.accessToken, projectId: session.projectId, recaptchaToken: captcha,
        prompt: state.prompts.imagePrompt, aspect: job.aspect || "portrait",
        model: imageModelId, referenceMediaIds: session.storyboardMediaIds || session.mediaIds, seed: imageSeed, signal,
      }), label, signal);
      checkpoint = {
        ...submitted,
        projectId: session.projectId,
        seed: submitted.seed ?? imageSeed,
        acceptedAt: Date.now(),
      };
      writeCheckpoint(job, "images", sceneIndex, checkpoint);
      store.log(`${label}: Flow รับงานภาพแล้ว`, "info", { stage: "image.accepted", scene: sceneIndex + 1 });
    }
    if (checkpoint.url) return checkpoint;
    try {
      return await flow.pollImageResult({ cookieHeader: session.cookieHeader, checkpoint, signal });
    } catch (error) {
      if (classifyFlowError(error.message) === "session") {
        store.log(`${label}: session หมดอายุระหว่างรอภาพ — เชื่อมใหม่แล้วรอ checkpoint เดิม`, "warn");
        await refreshRunnerSession(session, signal);
        return flow.pollImageResult({ cookieHeader: session.cookieHeader, checkpoint, signal });
      }
      error.acceptedCheckpoint = true;
      throw error;
    }
  }, async () => {
      checkpoint = null;
      imageSeed = nextSeed();
      writeCheckpoint(job, "images", sceneIndex, null);
      persistRoom(job, session);
      await restoreStoryboardReferences(
        session,
        session.characterImageUrl ? referenceImages.slice(0, 1) : referenceImages,
        session.characterImageUrl || "",
        `${label}: ย้ายห้อง — `,
        signal,
      );
    });
  checkpoint = { ...image, projectId: session.projectId, completedAt: Date.now() };
  writeCheckpoint(job, "images", sceneIndex, checkpoint);
  state.imageUrl = image.url;
  state.startImageMediaId = image.mediaId;
  if (!state.startImageMediaId) throw new Error("Flow ไม่คืน media id ของภาพเฟรมแรก");
  store.log(`${label}: สร้างภาพสำเร็จ`, "info", { stage: "image.completed", scene: sceneIndex + 1 });
  store.updateJob(job.id, { imageUrl: state.imageUrl || "" });
  onChange();
}

// ------------------------------------------------------------------ video
/** Generate this scene's video from its immediately preceding storyboard via
 *  batchAsyncGenerateVideoReferenceImages. Accepted checkpoints are persisted
 *  before polling; only a definitive FAILED status permits a resubmit. */
async function runSceneVideo({ job, model, referenceImages, sceneIndex, sceneCount, session, signal, state }, onChange) {
  const label = sceneCount > 1 ? `${job.title} [ฉาก ${sceneIndex + 1}/${sceneCount}]` : job.title;
  const imageUrl = state.imageUrl || "";
  let startImageMediaId = state.startImageMediaId || "";

  let checkpoint = readCheckpoint(job, "videos", sceneIndex);
  if (checkpoint?.url) {
    state.mediaName = checkpoint.pendingMediaName || checkpoint.mediaName;
    state.workflowId = checkpoint.workflowId || "";
    state.videoUrl = checkpoint.url;
    return;
  }
  let videoSeed = Number.isInteger(Number(checkpoint?.seed)) ? Number(checkpoint.seed) : nextSeed();
  store.log(`${label}: สร้างวิดีโอ ${model.label || model.id}`, "info", { stage: "video.started", scene: sceneIndex + 1 });
  const videoUrl = await withRoomAutoRecovery(session, label, signal, async () => {
    if (!checkpoint?.pendingMediaName) {
      checkpoint = await withFlowErrorModel(flow.RECAPTCHA_ACTION_VIDEO, session, (captcha) => flow.submitR2V({
        accessToken: session.accessToken, projectId: session.projectId, recaptchaToken: captcha,
        prompt: state.prompts.videoPrompt, videoModel: model.id, aspect: job.aspect || "portrait",
        referenceMediaIds: [startImageMediaId], seed: videoSeed, signal,
      }), label, signal, { videoModel: model.id });
      checkpoint = { ...checkpoint, projectId: session.projectId, acceptedAt: Date.now() };
      writeCheckpoint(job, "videos", sceneIndex, checkpoint);
      store.log(`${label}: Flow รับงานวิดีโอแล้ว`, "info", { stage: "video.accepted", scene: sceneIndex + 1 });
    }
    try {
      return await pollUntilDone({
        session, projectId: checkpoint.projectId || session.projectId,
        mediaName: checkpoint.pendingMediaName,
      }, job, onChange, label, signal);
    } catch (error) {
      if (definitiveGenerationFailure(error)) {
        checkpoint = null;
        videoSeed = nextSeed();
        writeCheckpoint(job, "videos", sceneIndex, null);
        throw error;
      }
      error.acceptedCheckpoint = true;
      throw error;
    }
  }, async () => {
    checkpoint = null;
    videoSeed = nextSeed();
    writeCheckpoint(job, "videos", sceneIndex, null);
    persistRoom(job, session);
    await restoreStoryboardReferences(
      session,
      session.characterImageUrl ? referenceImages.slice(0, 1) : referenceImages,
      session.characterImageUrl || "",
      `${label}: ย้ายห้อง — `,
      signal,
    );
    startImageMediaId = await flow.uploadReferenceImage(session.accessToken, session.projectId, imageUrl, signal);
    const imageCheckpoint = readCheckpoint(job, "images", sceneIndex) || {};
    writeCheckpoint(job, "images", sceneIndex, {
      ...imageCheckpoint,
      mediaId: startImageMediaId,
      pendingMediaName: startImageMediaId,
      projectId: session.projectId,
      url: imageUrl,
    });
    store.log(`${label}: อัปโหลดภาพ Storyboard เข้าห้องใหม่แล้ว`, "warn");
  });
  checkpoint = { ...checkpoint, url: videoUrl, completedAt: Date.now() };
  writeCheckpoint(job, "videos", sceneIndex, checkpoint);
  state.mediaName = checkpoint.pendingMediaName;
  state.workflowId = checkpoint.workflowId || "";
  state.videoUrl = videoUrl;
  store.log(`${label}: สร้างวิดีโอสำเร็จ`, "info", { stage: "video.completed", scene: sceneIndex + 1 });
}

function pickFlowValue(source, keys) {
  const wanted = new Set(keys);
  const seen = new Set();
  const queue = [source];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key) && typeof value === "string" && value.trim()) return value.trim();
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return "";
}

function continuousCheckpoint(result = {}) {
  return {
    url: result.localUrl || result.saved?.url || result.videoUrl || result.mediaUrl || result.resultUrl || "",
    mediaId: pickFlowValue(result, ["mediaId", "media_id", "pendingMediaName", "mediaName"]),
    pendingMediaName: pickFlowValue(result, ["pendingMediaName", "mediaName", "mediaId", "media_id"]),
    sceneId: pickFlowValue(result, ["sceneId", "scene_id"]),
    projectId: pickFlowValue(result, ["projectId", "project_id"]),
    workflowId: pickFlowValue(result, ["workflowId", "workflow_id"]),
    completedAt: Date.now(),
  };
}

function continuousScenePrompt(basePrompt, sceneIndex, sceneCount) {
  const sceneNo = sceneIndex + 1;
  const continuity = sceneIndex === 0
    ? "เปิดเรื่องให้ชัดเจน และล็อกตัวละคร ใบหน้า เสียง สินค้า เสื้อผ้า ฉาก แสง และมุมกล้องนี้ไว้สำหรับฉากถัดไป"
    : "ต่อเนื่องจากเฟรมสุดท้ายของคลิปก่อนหน้าทันที ห้ามเริ่มเรื่องใหม่ ห้ามเปลี่ยนตัวละคร ใบหน้า เสียง สินค้า เสื้อผ้า ฉาก แสง หรือมุมกล้อง ห้ามใช้ transition, fade, dissolve หรือภาพตัดดำ บทพูดต้องเป็นประโยคใหม่และห้ามพูดซ้ำจากคลิปก่อนหน้า";
  return [
    `Scene ${sceneNo}/${sceneCount} — ${sceneIndex === 0 ? "BASE SCENE" : "CONTINUOUS EXTENDED SCENE"}`,
    continuity,
    basePrompt,
  ].filter(Boolean).join("\n");
}

function scenePromptInput(job, sceneIndex) {
  if (!Array.isArray(job.sceneVideoPrompts)) return "";
  return String(job.sceneVideoPrompts[sceneIndex] || "").trim().slice(0, 5000);
}

function appendScenePromptInput(defaultPrompt, job, sceneIndex) {
  const customPrompt = scenePromptInput(job, sceneIndex);
  if (!customPrompt) return defaultPrompt;
  return [
    defaultPrompt,
    `USER VIDEO PROMPT — SCENE ${sceneIndex + 1}:`,
    customPrompt,
  ].filter(Boolean).join("\n\n");
}

function recordResolvedScenePrompt(job, sceneIndex, defaultPrompt, resolvedPrompt) {
  const current = store.job(job.id) || job;
  const resolved = Array.isArray(current.resolvedSceneVideoPrompts)
    ? [...current.resolvedSceneVideoPrompts]
    : [];
  const defaults = Array.isArray(current.defaultSceneVideoPrompts)
    ? [...current.defaultSceneVideoPrompts]
    : [];
  resolved[sceneIndex] = resolvedPrompt;
  defaults[sceneIndex] = defaultPrompt;
  store.updateJob(job.id, {
    sceneVideoPrompts: Array.isArray(job.sceneVideoPrompts) ? job.sceneVideoPrompts.slice(0, 10) : [],
    defaultSceneVideoPrompts: defaults,
    resolvedSceneVideoPrompts: resolved,
  });
}

/** Continuous mode creates one Original clip, then chains up to two fZytfe
 *  Extended hops. Each hop uses the immediately preceding mediaId and the same
 *  sceneId: Original -> Extended #1 -> Extended #2. */
async function runContinuousScenes({ job, shared, model, referenceImages, sceneCount, session, signal }, onChange) {
  const firstState = {};
  const baseModel = model || shared.videoModel(job.videoModel) || shared.videoModel(CONTINUOUS_BASE_VIDEO_MODEL);
  if (!baseModel || baseModel.family !== "r2v") {
    throw new Error(`โมเดล ${job.videoModel || ""} ใช้สร้างฉาก Original แบบ Storyboard ไม่ได้`);
  }
  await runSceneImage({
    job: { ...job, videoModel: baseModel.id },
    shared,
    model: baseModel,
    textMode: job.textMode === "noText" ? "noText" : "withText",
    referenceImages,
    sceneIndex: 0,
    sceneCount,
    session,
    signal,
    state: firstState,
  }, onChange);

  const storyboardImages = [{
    scene: 1,
    mediaId: firstState.startImageMediaId || "",
    url: firstState.imageUrl || "",
  }];
  store.updateJob(job.id, {
    storyboardImages,
    executionVideoModel: baseModel.id,
    extendedVideoModel: CONTINUOUS_EXTENDED_VIDEO_MODEL,
  });

  const scenes = [];
  const originalVideoPrompt = firstState.prompts?.videoPrompt || "";
  const originalDefaultPrompt = continuousScenePrompt(originalVideoPrompt, 0, sceneCount);
  firstState.prompts.videoPrompt = appendScenePromptInput(originalDefaultPrompt, job, 0);
  recordResolvedScenePrompt(job, 0, originalDefaultPrompt, firstState.prompts.videoPrompt);
  await runSceneVideo({
    job,
    model: baseModel,
    referenceImages,
    sceneIndex: 0,
    sceneCount,
    session,
    signal,
    state: firstState,
  }, onChange);
  let base = {
    url: firstState.videoUrl || "",
    mediaId: firstState.mediaName || "",
    pendingMediaName: firstState.mediaName || "",
    workflowId: firstState.workflowId || readCheckpoint(job, "videos", 0)?.workflowId || "",
    projectId: session.projectId,
  };
  if (!base.url || !base.mediaId) throw new Error("Flow ไม่คืนวิดีโอหรือ mediaId ของฉากแรกสำหรับ Extended");

  if (sceneCount > 1) {
    let sceneCheckpoint = readCheckpoint(job, "extendedScenes", 0);
    if (!sceneCheckpoint?.sceneId) {
      if (!base.workflowId) throw new Error("Flow ไม่คืน workflowId ของฉากแรก จึงสร้าง Scene สำหรับ Extended ไม่ได้");
      store.log(`${job.title} [ฉาก 1/${sceneCount}]: กำลังสร้าง Scene สำหรับ Extended`, "info", {
        stage: "extended.scene.create",
        workflowId: base.workflowId,
      });
      sceneCheckpoint = await withRateLimitRetry(() => flow.createScene({
        accessToken: session.accessToken,
        projectId: session.projectId,
        workflowId: base.workflowId,
        signal,
      }), `${job.title}: สร้าง Extended Scene`, signal);
      sceneCheckpoint = { ...sceneCheckpoint, createdAt: Date.now() };
      writeCheckpoint(job, "extendedScenes", 0, sceneCheckpoint);
    }
    base = {
      ...base,
      sceneId: sceneCheckpoint.sceneId,
      mediaId: sceneCheckpoint.primaryMediaId || base.mediaId,
    };
  }
  writeCheckpoint(job, "extendedVideos", 0, { ...base, completedAt: Date.now() });
  scenes.push({ scene: 1, imageUrl: firstState.imageUrl || "", mediaName: base.mediaId, url: base.url });
  store.updateJob(job.id, { scenes, storyboardImages });
  onChange();

  let previous = base;
  for (let sceneIndex = 1; sceneIndex < sceneCount; sceneIndex += 1) {
    const sceneNo = sceneIndex + 1;
    // Match TripleBot: each hop receives the full Extend_Video JSON contract.
    // The last clip always uses the dedicated closing/CTA action, while a
    // per-scene operator value replaces only dialogue_script.
    const extendDefaultPrompt = shared.buildTripleBotExtendedPrompt({
      sceneIndex,
      sceneCount,
      direction: job.direction || {},
      product: job.product || { name: job.title || "" },
    });
    const extendPrompt = shared.buildTripleBotExtendedPrompt({
      sceneIndex,
      sceneCount,
      direction: job.direction || {},
      product: job.product || { name: job.title || "" },
      sceneInstruction: scenePromptInput(job, sceneIndex),
    });
    recordResolvedScenePrompt(job, sceneIndex, extendDefaultPrompt, extendPrompt);
    let extended = readCheckpoint(job, "extendedVideos", sceneIndex);
    if (!extended?.url) {
      store.log(`${job.title} [ฉาก ${sceneNo}/${sceneCount}]: กำลังต่อจากฉาก ${sceneNo - 1} ด้วย Extended`, "info", {
        stage: "extended.scene.started",
        model: CONTINUOUS_EXTENDED_VIDEO_MODEL,
        sourceMediaId: previous.mediaId || previous.pendingMediaName,
        sceneId: previous.sceneId || base.sceneId,
      });
      if (!extended?.pendingMediaName) {
        const result = await withFlowErrorModel(
          flow.RECAPTCHA_ACTION_VIDEO,
          session,
          (captcha) => submitExtendedVideo({
            jobId: `${job.id}-scene-${sceneNo}`,
            projectId: previous.projectId || base.projectId || session.projectId,
            sourceMediaId: previous.mediaId || previous.pendingMediaName,
            sceneId: previous.sceneId || base.sceneId,
            prompt: extendPrompt,
            captchaToken: captcha,
            videoModel: CONTINUOUS_EXTENDED_VIDEO_MODEL,
            position: sceneIndex,
            aspect: job.aspect || "portrait",
          }, signal),
          `${job.title} [ฉาก ${sceneNo}/${sceneCount}]`,
          signal,
          { videoModel: CONTINUOUS_EXTENDED_VIDEO_MODEL },
        );
        extended = { ...continuousCheckpoint(result), acceptedAt: Date.now() };
        if (!extended.pendingMediaName) throw new Error("Flow ไม่คืน mediaId ของงาน Extended");
        writeCheckpoint(job, "extendedVideos", sceneIndex, extended);
        store.log(`${job.title} [ฉาก ${sceneNo}/${sceneCount}]: Flow รับงาน Extended แล้ว`, "info", {
          stage: "extended.scene.accepted",
          mediaId: extended.pendingMediaName,
        });
      }
      try {
        const url = await pollUntilDone({
          session,
          projectId: extended.projectId || session.projectId,
          mediaName: extended.pendingMediaName,
        }, job, onChange, `${job.title} [ฉาก ${sceneNo}/${sceneCount}]`, signal);
        extended = { ...extended, url, completedAt: Date.now() };
        writeCheckpoint(job, "extendedVideos", sceneIndex, extended);
      } catch (error) {
        if (definitiveGenerationFailure(error)) writeCheckpoint(job, "extendedVideos", sceneIndex, null);
        else error.acceptedCheckpoint = true;
        throw error;
      }
    }
    if (!extended.url || !(extended.mediaId || extended.pendingMediaName)) {
      throw new Error(`Flow ไม่คืนวิดีโอฉากที่ ${sceneNo} จาก Extended`);
    }
    extended = {
      ...extended,
      mediaId: extended.mediaId || extended.pendingMediaName,
      sceneId: extended.sceneId || previous.sceneId || base.sceneId,
      projectId: extended.projectId || previous.projectId || base.projectId || session.projectId,
    };
    scenes.push({ scene: sceneNo, imageUrl: "", mediaName: extended.mediaId, url: extended.url });
    store.updateJob(job.id, { scenes, storyboardImages });
    onChange();
    previous = extended;
  }

  return { scenes, storyboardImages };
}

// ------------------------------------------------------------------ job
async function runJob(job, signal, onChange) {
  const shared = await loadShared();
  const storedProduct = store.product(job.productId);
  if (!storedProduct) throw new Error(`ไม่พบสินค้า ${job.productId}`);
  job = { ...job, product: storedProduct, productImage: job.thumb || storedProduct.images?.[0] || storedProduct.image || "" };
  const sceneMode = FLOW_EXTENDED_ENABLED && job.sceneMode === "continuous" ? "continuous" : "independent";
  const sceneCount = Math.max(1, Math.min(sceneMode === "continuous" ? 3 : 10, Number(job.sceneCount) || 1));
  const legacyModelMap = {
    veo_3_1_i2v_lite_low_priority: "veo_3_1_r2v_lite_low_priority",
    veo_3_1_i2v_lite: "veo_3_1_r2v_lite",
    veo_3_1_i2v_s_fast_portrait_ultra: "veo_3_1_r2v_lite",
  };
  const requestedModelId = String(job.videoModel || shared.DEFAULT_VIDEO_MODEL);
  const modelId = legacyModelMap[requestedModelId] || requestedModelId;
  const model = shared.videoModel(modelId);
  if (!model || model.family !== "r2v") {
    throw new Error(`โมเดล ${requestedModelId} ใช้กับ Storyboard Reference Video ไม่ได้`);
  }
  if (modelId !== requestedModelId) {
    store.log(`${job.title}: เปลี่ยนโมเดล I2V เดิมเป็น ${model.label} สำหรับ Storyboard Reference Video`, "warn");
    store.updateJob(job.id, { videoModel: modelId });
  }
  job = {
    ...job,
    characterMode: job.characterMode === "consistent" ? "consistent" : "random",
    sceneMode,
    sceneCount,
    videoModel: modelId,
  };
  store.updateJob(job.id, { characterMode: job.characterMode, sceneMode, sceneCount, executionVideoModel: model.id });

  const referenceImages = (job.referenceImages?.length ? job.referenceImages : (job.product?.images?.length ? job.product.images : [job.productImage]))
    .filter(Boolean).slice(0, 3);
  if (!referenceImages.length) throw new Error("สินค้านี้ไม่มีรูปสำหรับใช้อ้างอิง");

  const textMode = job.textMode === "noText" ? "noText" : "withText";
  const orderNumber = job.orderNumber || mediaStore.genOrderNumber();
  if (!job.orderNumber) store.updateJob(job.id, { orderNumber });

  flow.resetTrace();
  const projectCache = { projectId: String(job.flowProjectId || "").trim() || null, title: orderNumber };
  try {
    const session = await ensureFlowSession(projectCache, signal);
    persistRoom(job, session);
    const useCharacterReference = usesConsistentCharacter(job.characterMode);
    const productReferenceImages = useCharacterReference ? referenceImages.slice(0, 1) : referenceImages;
    session.mediaIds = await uploadReferences(session.accessToken, session.projectId, productReferenceImages, `${job.title}: `, signal);
    session.productMediaProjectId = session.projectId;
    session.storyboardMediaIds = [...session.mediaIds];
    if (useCharacterReference) {
      const character = await runCharacterReference({ job, shared, session, signal }, onChange);
      if (session.productMediaProjectId !== session.projectId) {
        session.mediaIds = await uploadReferences(session.accessToken, session.projectId, productReferenceImages, `${job.title}: อัปโหลดรูปสินค้าเข้าห้องใหม่ — `, signal);
        session.productMediaProjectId = session.projectId;
      }
      session.characterImageUrl = character.url;
      session.characterMediaId = character.mediaId;
      session.storyboardMediaIds = [character.mediaId, ...session.mediaIds].filter(Boolean);
      store.updateJob(job.id, { storyboardReferenceCount: session.storyboardMediaIds.length });
    }

    let scenes = [];
    let storyboardImages = [];
    if (sceneMode === "continuous") {
      ({ scenes, storyboardImages } = await runContinuousScenes({
        job, shared, model, referenceImages, sceneCount, session, signal,
      }, onChange));
    } else {
      // N independent clips use N+1 storyboard images and run in strict order.
      const sceneStates = Array.from({ length: sceneCount + 1 }, () => ({}));
      for (let i = 0; i <= sceneCount; i += 1) {
        await runSceneImage({ job, shared, model, textMode, referenceImages, sceneIndex: i, sceneCount, session, signal, state: sceneStates[i] }, onChange);
        storyboardImages.push({ scene: i + 1, mediaId: sceneStates[i].startImageMediaId || "", url: sceneStates[i].imageUrl || "" });
        store.updateJob(job.id, { storyboardImages });
        if (i === sceneCount) break;
        const defaultVideoPrompt = sceneStates[i].prompts.videoPrompt;
        sceneStates[i].prompts.videoPrompt = appendScenePromptInput(defaultVideoPrompt, job, i);
        recordResolvedScenePrompt(job, i, defaultVideoPrompt, sceneStates[i].prompts.videoPrompt);
        await runSceneVideo({ job, model, referenceImages, sceneIndex: i, sceneCount, session, signal, state: sceneStates[i] }, onChange);
        scenes.push({
          scene: i + 1,
          imageUrl: sceneStates[i].imageUrl || "",
          mediaName: sceneStates[i].mediaName || "",
          url: sceneStates[i].videoUrl || "",
        });
        store.updateJob(job.id, { scenes, storyboardImages });
        onChange();
      }
    }

    // Download and merge locally. finalizeScenes normalises resolution/fps,
    // H.264 video and AAC audio before concat, avoiding another Flow operation
    // and keeping the final file reproducible outside the browser session.
    store.log(`${job.title}: กำลังดาวน์โหลดและรวม ${scenes.length} ฉากในเครื่อง`);
    const completedJob = store.job(job.id) || job;
    const promptLog = {
      defaultBehavior: "Prompt ปัจจุบันเป็นค่าเริ่มต้น และต่อท้ายข้อความรายฉากเมื่อมีการกรอก",
      extraPrompt: job.extraPrompt || "",
      scenePromptInputs: Array.isArray(job.sceneVideoPrompts) ? job.sceneVideoPrompts.slice(0, sceneCount) : [],
      defaultVideoPrompts: Array.isArray(completedJob.defaultSceneVideoPrompts)
        ? completedJob.defaultSceneVideoPrompts.slice(0, sceneCount)
        : [],
      videoPrompts: Array.isArray(completedJob.resolvedSceneVideoPrompts)
        ? completedJob.resolvedSceneVideoPrompts.slice(0, sceneCount)
        : [],
    };
    const finalResult = await finalizeScenes({
      scenes, orderNumber, model, session, signal, storyboardImages, promptLog,
    });

    mediaStore.writeConnectLog(orderNumber, {
      productId: job.productId || "", productName: job.title || "", productUrl: job.product?.url || "",
      videoModel: model.id,
      extendedVideoModel: sceneMode === "continuous" ? CONTINUOUS_EXTENDED_VIDEO_MODEL : "",
      sceneMode, sceneCount: scenes.length, textMode, scenes, promptLog,
      finalVideo: finalResult.finalVideoPath || "",
      status: "done", createdAt: job.createdAt, finishedAt: Date.now(),
    });

    return {
      imageUrl: storyboardImages[storyboardImages.length - 1].url || "",
      videoUrl: finalResult.url || "",
      finalVideoPath: finalResult.finalVideoPath || "",
      finalVideoUrl: finalResult.resultUrl || "",
      orderNumber,
      sceneMode,
      executionVideoModel: model.id,
      extendedVideoModel: sceneMode === "continuous" ? CONTINUOUS_EXTENDED_VIDEO_MODEL : "",
      scenes,
      promptLog,
    };
  } finally {
    reportFlowTrace();
    onChange();
  }
}

/** Standalone "🧪 ทดสอบสร้างรูป" preview — the same generateImage() call a real
 *  job's phase 1 makes, without any of the video steps after it. Costs credits. */
async function testGenerateImage({ product, direction, characterMode, imageModel, aspect, extraPrompt, projectId }) {
  const shared = await loadShared();
  if (!product) throw new Error("เลือกสินค้าก่อน");
  const images = (product.images || []).slice(0, 3);
  if (!images.length) throw new Error("สินค้านี้ไม่มีรูปสำหรับใช้อ้างอิง");
  const prompts = shared.buildPrompt({
    product, direction: direction || {}, videoModel: shared.DEFAULT_VIDEO_MODEL,
    extraPrompt: extraPrompt || "", textMode: "withText",
  });
  const label = `ทดสอบสร้างรูป: ${product.name}`;
  store.log(label, "info", { stage: "test-image.started" });
  flow.resetTrace();
  try {
    const requestedProjectId = String(projectId || "").trim();
    const projectCache = /^[A-Za-z0-9-]{8,64}$/.test(requestedProjectId)
      ? { projectId: requestedProjectId, title: "BlueSPite Image Test" }
      : testImageProjectCache;
    const session = await ensureFlowSession(projectCache, null);
    const useCharacterReference = usesConsistentCharacter(characterMode);
    session.mediaIds = await uploadReferences(
      session.accessToken,
      session.projectId,
      useCharacterReference ? images.slice(0, 1) : images,
      "",
      null,
    );
    let characterImage = null;
    if (useCharacterReference) {
      const characterPrompt = shared.buildCharacterPrompt({ direction: direction || {} });
      store.log(`${label}: สร้างภาพตัวละครอ้างอิงก่อน Storyboard`, "info", { stage: "test-image.character.started" });
      characterImage = await withFlowErrorModel(flow.RECAPTCHA_ACTION_IMAGE, session, (captcha) => flow.generateImage({
        accessToken: session.accessToken, projectId: session.projectId, recaptchaToken: captcha,
        prompt: characterPrompt, aspect: aspect || "portrait",
        model: imageModel || shared.DEFAULT_IMAGE_MODEL, referenceMediaIds: [], signal: null,
      }), `${label}: ภาพตัวละครอ้างอิง`, null);
      if (!characterImage.url) characterImage = await flow.pollImageResult({ cookieHeader: session.cookieHeader, checkpoint: characterImage, signal: null });
      const characterMediaId = characterImage.mediaId || characterImage.pendingMediaName || "";
      if (!characterImage.url || !characterMediaId) throw new Error("Flow ไม่คืนรูปหรือ mediaId ของตัวละครอ้างอิง");
      session.mediaIds = [characterMediaId, session.mediaIds[0]].filter(Boolean);
      prompts.imagePrompt += "\n\nCHARACTER IDENTITY — STRICT: The first reference image is the approved character identity. Reproduce exactly the same adult person: same face, hairstyle, apparent age, body proportions, and clothing. The remaining reference image is the real product and must remain exact.";
    }
    let image = await withFlowErrorModel(flow.RECAPTCHA_ACTION_IMAGE, session, (captcha) => flow.generateImage({
      accessToken: session.accessToken, projectId: session.projectId, recaptchaToken: captcha,
      prompt: prompts.imagePrompt, aspect: aspect || "portrait",
      model: imageModel || shared.DEFAULT_IMAGE_MODEL, referenceMediaIds: session.mediaIds, signal: null,
    }), label, null);
    if (!image.url) image = await flow.pollImageResult({ cookieHeader: session.cookieHeader, checkpoint: image, signal: null });
    store.log(`ทดสอบสร้างรูปสำเร็จ: ${product.name}`, "info", { stage: "test-image.done", mediaId: image.mediaId });
    return {
      url: image.url, mediaId: image.mediaId || "", prompt: prompts.imagePrompt,
      characterImageUrl: characterImage?.url || "",
    };
  } catch (err) {
    store.log(`ทดสอบสร้างรูปล้มเหลว: ${err.message}`, "error", { stage: "test-image.failed", error: err.message });
    throw err;
  } finally {
    reportFlowTrace();
  }
}


export {
  runnerState, cancelJob, requestStop, startQueue, retryFailedJobs,
  startQueueWithFailedFallback, testGenerateImage, classifyFlowError,
};
