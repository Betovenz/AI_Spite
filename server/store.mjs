// Flat-file store for BlueSPite. One JSON document, debounced atomic writes.
//
// Deliberately not a database: the whole working set is a few hundred products and
// jobs on a single operator's machine, and a plain file keeps the app dependency-free
// and trivially inspectable/backup-able. If this ever needs concurrency, swap this
// module — nothing outside it touches the file.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so a throwaway test bridge can point at its own file instead of
// silently sharing (and racing writes to) data/bluespite.json with a real one.
export const DATA_DIR = process.env.BLUESPITE_DATA_DIR || join(HERE, "..", "data");
const DB_PATH = join(DATA_DIR, "bluespite.json");
const TMP_PATH = `${DB_PATH}.tmp`;

const MAX_LOG = 1500;
const MAX_HISTORY = 2000;

function emptyDb() {
  return {
    version: 1,
    settings: {
      // Which Flow account tier the model dropdown should reflect. The extension
      // reports this when it can read it; "x20" is the optimistic default.
      flowTier: "x20",
      // Generate defaults — set once on the "ตั้งค่า Prompt" page, applied to every
      // job queued from the scan page (per-product button or "ส่งสร้างวิดีโอทั้งหมด").
      defaultVideoModel: "veo_3_1_r2v_lite",
      defaultImageModel: "NARWHAL",
      aspect: "portrait",
      characterMode: "random",       // "random" | "consistent"
      sceneMode: "independent",      // "independent" | "continuous"
      // Scenes per job — each gets its own image+video, then all scenes merge into
      // one final video (server/runner.mjs). Replaces the old "copies" (N
      // independent videos); see shared/catalog.mjs and server/media-store.mjs.
      sceneCount: 1,
      concurrency: 1,   // 1-10 jobs run at once; see shared/catalog.mjs CONCURRENT_SAFE_MODELS
      textMode: "withText",   // "withText" | "noText", see shared/catalog.mjs TEXT_MODES
      direction: {},   // field -> value ("" | id | "custom:text"), see shared/catalog.mjs
      extraPrompt: "",
      sceneVideoPrompts: [],
      // Shopee search ranking weights (see rankProducts in search.mjs).
      rank: { sales: 1, rating: 1, price: 1, commission: 1 },
    },
    products: [],   // scanned product records
    searches: [],   // recent keyword searches (most recent first, capped)
    jobs: [],       // generate queue — working list, prunable via clearJobs()
    // Durable record of finished jobs, independent of `jobs` — clearJobs() (the
    // Queue page's "ล้างงานที่จบแล้ว" button) deletes rows from `jobs`, which used
    // to silently wipe the History page too since it rendered straight off that
    // same array. History reads from here instead, so clearing the Queue view
    // never loses it. See recordHistory()/history() below and runner.mjs's
    // recordJobHistory().
    history: [],
    log: [],        // ring buffer of {ts, level, msg}
    orderSeq: 0,    // persisted counter behind media-store.mjs's genOrderNumber()
  };
}

let db = null;
let writeTimer = null;

function load() {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(DB_PATH, "utf8"));
      db = { ...emptyDb(), ...parsed };
      db.settings = { ...emptyDb().settings, ...(parsed.settings || {}) };
      const legacyModelMap = {
        veo_3_1_i2v_lite_low_priority: "veo_3_1_r2v_lite_low_priority",
        veo_3_1_i2v_lite: "veo_3_1_r2v_lite",
        veo_3_1_i2v_s_fast_portrait_ultra: "veo_3_1_r2v_lite",
      };
      if (legacyModelMap[db.settings.defaultVideoModel]) {
        db.settings.defaultVideoModel = legacyModelMap[db.settings.defaultVideoModel];
      }
      db.settings.characterMode = db.settings.characterMode === "consistent" ? "consistent" : "random";
      db.settings.sceneMode = db.settings.sceneMode === "continuous" ? "continuous" : "independent";
      db.settings.sceneVideoPrompts = normalizeSceneVideoPrompts(db.settings.sceneVideoPrompts);
      // One-time backfill for a db file that predates the history/jobs split above:
      // recover what's still sitting in `jobs` (any finished-and-not-yet-cleared
      // ones) so upgrading doesn't present as "history is empty" on the first run.
      if (parsed.history === undefined) {
        db.history = (parsed.jobs || [])
          .filter((j) => j.orderNumber && j.status !== "queued" && j.status !== "running")
          .map((j) => ({
            jobId: j.id, orderNumber: j.orderNumber, title: j.title,
            textMode: j.textMode, sceneCount: j.sceneCount, status: j.status,
            startedAt: j.startedAt, finishedAt: j.finishedAt,
            finalVideoPath: j.finalVideoPath, finalVideoUrl: j.finalVideoUrl,
            videoUrl: j.videoUrl, thumb: j.thumb, error: j.error || "",
            recordedAt: j.finishedAt || j.updatedAt || Date.now(),
          }));
      }
    } catch (err) {
      // A corrupt file must not brick the app — keep it aside and start clean.
      const backup = `${DB_PATH}.corrupt-${Date.now()}`;
      try { renameSync(DB_PATH, backup); } catch { /* best effort */ }
      console.error(`[store] ${DB_PATH} was unreadable (${err.message}); moved to ${backup}`);
      db = emptyDb();
    }
  } else {
    db = emptyDb();
  }
  return db;
}

// Atomic-ish write: temp file + rename, so a crash mid-write cannot truncate the db.
function flush() {
  writeTimer = null;
  if (!db) return;
  try {
    writeFileSync(TMP_PATH, JSON.stringify(db, null, 2), "utf8");
    renameSync(TMP_PATH, DB_PATH);
  } catch (err) {
    console.error(`[store] write failed: ${err.message}`);
  }
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(flush, 250);
}

export function state() {
  return load();
}

export function save() {
  persist();
}

export function flushNow() {
  if (writeTimer) clearTimeout(writeTimer);
  flush();
}

// ------------------------------------------------------------------ settings
export function settings() {
  const current = load().settings;
  return {
    ...current,
    characterMode: current.characterMode === "consistent" ? "consistent" : "random",
    sceneMode: current.sceneMode === "continuous" ? "continuous" : "independent",
  };
}

function normalizeSceneVideoPrompts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((prompt) => String(prompt || "").slice(0, 5000));
}

export function updateSettings(patch = {}) {
  const s = load();
  s.settings = { ...s.settings, ...patch };
  // rank/direction are partial-update objects (e.g. one slider, one dropdown) —
  // merge into the existing object instead of replacing it wholesale.
  if (patch.rank) s.settings.rank = { ...s.settings.rank, ...patch.rank };
  if (patch.direction) s.settings.direction = { ...s.settings.direction, ...patch.direction };
  s.settings.characterMode = s.settings.characterMode === "consistent" ? "consistent" : "random";
  s.settings.sceneMode = s.settings.sceneMode === "continuous" ? "continuous" : "independent";
  const maxScenes = s.settings.sceneMode === "continuous" ? 3 : 10;
  s.settings.sceneCount = Math.max(1, Math.min(maxScenes, Number(s.settings.sceneCount) || 1));
  s.settings.sceneVideoPrompts = normalizeSceneVideoPrompts(s.settings.sceneVideoPrompts);
  flushNow();
  return { ...s.settings };
}

// ------------------------------------------------------------------ logging
// `meta` is optional structured detail (e.g. {videoModel, direction}) shown only in
// the web UI's Dev log mode — mirrors ref1's per-entry {stage, metadata}, kept out
// of ทั่วไป mode so the everyday narrative stays readable.
const MAX_JOB_TEXT = 5000;

function trimJobText(value) {
  const text = String(value);
  const dataUri = /^data:([^;,]*)/i.exec(text);
  if (dataUri) return `data:${dataUri[1] || "?"} (${Math.round(text.length / 1024)} KB inline)`;
  return text.length > MAX_JOB_TEXT
    ? `${text.slice(0, MAX_JOB_TEXT)}… (ตัดข้อความยาว ${text.length} ตัวอักษร)`
    : text;
}

function trimJobPatch(patch) {
  const out = { ...patch };
  for (const field of ["error", "note", "videoUrl", "finalVideoUrl", "imageUrl"]) {
    if (typeof out[field] === "string") out[field] = trimJobText(out[field]);
  }
  return out;
}

export function log(msg, level = "info", meta = null) {
  const s = load();
  const entry = { ts: Date.now(), level, msg: trimJobText(msg) };
  if (meta && typeof meta === "object" && Object.keys(meta).length) {
    entry.meta = Object.fromEntries(
      Object.entries(meta).map(([key, value]) => [key, typeof value === "string" ? trimJobText(value) : value]),
    );
  }
  s.log.push(entry);
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
  persist();
  return entry;
}

export function logTail(n = 120) {
  return load().log.slice(-n);
}

export function clearLog() {
  const s = load();
  s.log = [];
  persist();
}

// ------------------------------------------------------------------ products
// A product is keyed by `${shopid}_${itemid}` so re-scanning the same link updates
// the record in place instead of piling up duplicates.
export function productKey(shopid, itemid) {
  return `${shopid}_${itemid}`;
}

export function upsertProduct(record) {
  const s = load();
  const id = record.id || productKey(record.shopid, record.itemid);
  const now = Date.now();
  const idx = s.products.findIndex((p) => p.id === id);
  const merged = {
    ...(idx >= 0 ? s.products[idx] : {}),
    ...record,
    id,
    scannedAt: now,
    createdAt: idx >= 0 ? s.products[idx].createdAt : now,
  };
  if (idx >= 0) s.products[idx] = merged;
  else s.products.unshift(merged);
  persist();
  return merged;
}

export function products() {
  return load().products;
}

export function product(id) {
  return load().products.find((p) => p.id === id) || null;
}

export function deleteProduct(id) {
  const s = load();
  const before = s.products.length;
  s.products = s.products.filter((p) => p.id !== id);
  persist();
  return before !== s.products.length;
}

export function clearProducts() {
  const s = load();
  s.products = [];
  persist();
}

// ------------------------------------------------------------------ searches
export function recordSearch(keyword, items) {
  const s = load();
  s.searches = s.searches.filter((entry) => entry.keyword !== keyword);
  s.searches.unshift({ keyword, ts: Date.now(), items });
  if (s.searches.length > 20) s.searches.length = 20;
  persist();
  return s.searches[0];
}

export function searches() {
  return load().searches;
}

// ------------------------------------------------------------------ jobs
let jobSeq = 0;

export function newJobId() {
  jobSeq += 1;
  return `j${Date.now().toString(36)}${jobSeq.toString(36)}`;
}

export function addJob(job) {
  const s = load();
  const record = {
    ...job,
    sceneVideoPrompts: normalizeSceneVideoPrompts(job.sceneVideoPrompts),
    id: job.id || newJobId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  s.jobs.unshift(record);
  persist();
  return record;
}

export function jobs() {
  return load().jobs;
}

export function job(id) {
  return load().jobs.find((j) => j.id === id) || null;
}

// A job persisted as "running" only means a lane was mid-way through it when the
// bridge process last wrote to disk — if the process then restarted (crash, manual
// kill, update), that lane and its AbortController are both gone, so nothing is
// actually working on the job anymore and nothing will ever answer "หยุด"/"ยกเลิก"
// for it (there's no live controller left to abort). Called once at bridge startup,
// before the queue runner can possibly be draining anything, so any "running" job
// found here is unambiguously orphaned, never a live one.
export function reconcileOrphanedJobs() {
  const s = load();
  let count = 0;
  for (const j of s.jobs) {
    if (j.status === "running") {
      j.status = "failed";
      j.error = "งานค้างจากบริดจ์ที่รีสตาร์ท — กด \"ลองใหม่\" ถ้าต้องการรันอีกครั้ง";
      j.finishedAt = Date.now();
      j.updatedAt = Date.now();
      count += 1;
    }
  }
  if (count) persist();
  return count;
}

export function updateJob(id, patch) {
  const s = load();
  const idx = s.jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  s.jobs[idx] = { ...s.jobs[idx], ...trimJobPatch(patch), updatedAt: Date.now() };
  persist();
  return s.jobs[idx];
}

// ------------------------------------------------------------------ order numbers
// Persisted sequence behind media-store.mjs's genOrderNumber() — survives restarts so
// order numbers keep sorting in creation order across sessions.
export function nextOrderSeq() {
  const s = load();
  s.orderSeq = (s.orderSeq || 0) + 1;
  persist();
  return s.orderSeq;
}

export function clearJobs(ids = null) {
  const s = load();
  // Never drop a job that is mid-flight — the runner still holds a reference to it.
  s.jobs = s.jobs.filter((j) => j.status === "running" || (ids ? !ids.includes(j.id) : false));
  persist();
}

// ------------------------------------------------------------------ history
// Append-only, unaffected by clearJobs() above — a finished job's lean summary
// lands here (via runner.mjs's recordJobHistory()) so the History page survives
// the operator clearing their Queue view.
export function recordHistory(entry) {
  const s = load();
  s.history.unshift({ ...trimJobPatch(entry), recordedAt: Date.now() });
  if (s.history.length > MAX_HISTORY) s.history.length = MAX_HISTORY;
  persist();
}

export function history() {
  return load().history;
}

// No "clear all" on purpose (operator's explicit call — History deletion is
// per-status only: ลบงานที่สำเร็จ/ล้มเหลว/ยกเลิก are three separate buttons, never
// one that wipes everything at once). `status` is required, not optional.
export function clearHistoryByStatus(status) {
  const s = load();
  const before = s.history.length;
  s.history = s.history.filter((h) => h.status !== status);
  persist();
  return before - s.history.length;
}
