// BlueSPite bridge — serves the web UI, brokers commands to the extension, and runs
// the generate queue. Loopback only: nothing here should be reachable off the machine.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTION, DEFAULT_PORT, PORT_SCAN_SPAN, JOB, SERVICE } from "../shared/protocol.mjs";
import {
  FLOW_IMAGE_MODELS, videoModelsForTier, videoModel, DEFAULT_VIDEO_MODEL,
  DEFAULT_IMAGE_MODEL, STYLE_OPTIONS, DIRECTION_FIELDS, ASPECTS_VIDEO,
  TEXT_MODES, DEFAULT_TEXT_MODE, MAX_CONCURRENCY, DEFAULT_CONCURRENCY, CONCURRENT_SAFE_MODELS,
} from "../shared/catalog.mjs";
import { buildPrompt } from "../shared/prompt.mjs";
import * as store from "./store.mjs";
import * as ext from "./ext-link.mjs";
import * as shopee from "./shopee.mjs";
import { startQueue, requestStop, runnerState, testGenerateImage, cancelJob } from "./runner.mjs";
import { genOrderNumber, MEDIA_DIR } from "./media-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..");
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// ------------------------------------------------------------ SSE fan-out to the UI
const uiClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of uiClients) {
    try { res.write(payload); } catch { uiClients.delete(res); }
  }
}

function pushState() {
  broadcast("state", snapshot());
}

function snapshot() {
  const s = store.settings();
  return {
    service: SERVICE,
    ext: ext.extStatus(),
    runner: runnerState(),
    settings: s,
    products: store.products(),
    searches: store.searches().slice(0, 5),
    jobs: store.jobs().slice(0, 200),
    history: store.history().slice(0, 500),
    log: store.logTail(300),
    catalog: {
      imageModels: FLOW_IMAGE_MODELS,
      videoModels: videoModelsForTier(s.flowTier),
      aspects: ASPECTS_VIDEO,
      directionFields: DIRECTION_FIELDS,
      styleOptions: STYLE_OPTIONS,
      textModes: TEXT_MODES,
      maxConcurrency: MAX_CONCURRENCY,
      concurrentSafeModels: CONCURRENT_SAFE_MODELS,
      defaults: {
        videoModel: DEFAULT_VIDEO_MODEL, imageModel: DEFAULT_IMAGE_MODEL,
        textMode: DEFAULT_TEXT_MODE, concurrency: DEFAULT_CONCURRENCY,
      },
    },
  };
}

// ------------------------------------------------------------------- helpers
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("payload ใหญ่เกินกำหนด");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON ไม่ถูกต้อง");
  }
}

async function serveStatic(req, res, pathname) {
  // web/ is the site root; shared/ is exposed so the browser imports the SAME
  // catalog/prompt modules the bridge uses.
  const rel = pathname === "/" ? "/index.html" : pathname;
  const base = rel.startsWith("/shared/") ? ROOT : join(ROOT, "web");
  const target = normalize(join(base, rel.startsWith("/shared/") ? rel : rel));
  // Path-traversal guard: the resolved file must stay inside the two allowed roots.
  const allowed = [join(ROOT, "web"), join(ROOT, "shared")];
  if (!allowed.some((dir) => target.startsWith(dir))) {
    return json(res, 403, { error: "forbidden" });
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: `not found: ${rel}` });
  }
}

// Serves generated images/videos straight from MEDIA_DIR (Documents/BlueSPite/
// Generated Media/) — the video-preview popup plays the LOCAL downloaded file
// through this route rather than the remote Flow URL. Range support (HTTP 206) is
// what lets the <video> element seek/scrub instead of only playing start-to-end.
const MEDIA_DIR_NORMALIZED = normalize(MEDIA_DIR);

async function serveMedia(req, res, pathname) {
  const rel = decodeURIComponent(pathname.slice("/media/".length));
  const target = normalize(join(MEDIA_DIR_NORMALIZED, rel));
  if (!target.startsWith(MEDIA_DIR_NORMALIZED)) return json(res, 403, { error: "forbidden" });

  let info;
  try {
    info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    return json(res, 404, { error: `not found: ${rel}` });
  }

  const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : info.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= info.size) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${info.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(res);
}

// --------------------------------------------------------------- route handlers
// Every Shopee/Flow call below is an ext.command — the bridge itself never talks to
// a provider. Keep it that way.

async function handleSearch(body) {
  const keyword = String(body.keyword || "").trim();
  if (!keyword) throw new Error("ใส่คำค้นก่อน");
  const limit = Math.min(Math.max(Number(body.limit) || 60, 10), 120);

  store.log(`ค้นหา Shopee: "${keyword}"`);
  const raw = await ext.command(ACTION.SHOPEE_SEARCH, {
    keyword, limit,
    newest: Number(body.page || 0) * limit,
    minPrice: Number(body.minPrice) || 0,
    maxPrice: Number(body.maxPrice) || 0,
  }, 90_000);

  const rawItems = raw?.items || [];
  if (rawItems.length) store.log(`[debug] ${shopee.describeRawItem(rawItems[0])}`, "debug");
  let items = rawItems.map(shopee.normaliseItem).filter((i) => i.itemid && i.shopid);
  const missingImage = items.filter((i) => !i.image).length;
  if (missingImage) {
    store.log(`[debug] ${missingImage}/${items.length} รายการไม่มีรูป — ดูบรรทัด shape= ด้านบนเพื่อหา field รูปที่ถูกต้อง`, "debug");
  }

  // Commission is a separate affiliate endpoint (ref3 api/v3/offer/product/list) and is
  // only available to affiliate accounts, so a failure here must not fail the search.
  if (body.withCommission && items.length) {
    try {
      const offers = await ext.command(ACTION.SHOPEE_OFFER, {
        items: items.map((i) => ({ shopid: i.shopid, itemid: i.itemid })),
      }, 90_000);
      const rates = new Map((offers?.rates || []).map((r) => [`${r.shopid}_${r.itemid}`, Number(r.rate) || 0]));
      items = items.map((i) => ({ ...i, commissionRate: rates.get(i.id) || 0 }));
      store.log(`ดึงค่าคอมฯ ได้ ${rates.size}/${items.length} รายการ`);
    } catch (err) {
      store.log(`ดึงค่าคอมฯ ไม่ได้ (${err.message}) — จัดอันดับโดยไม่ใช้ค่าคอมฯ`, "warn");
    }
  }

  const ranked = shopee.rankProducts(items, store.settings().rank);
  store.recordSearch(keyword, ranked);
  store.log(`พบ ${ranked.length} รายการสำหรับ "${keyword}"`, "info", {
    stage: "search.done", keyword, count: ranked.length, withCommission: Boolean(body.withCommission),
  });
  return { keyword, items: ranked };
}

async function handleScan(body) {
  const links = Array.isArray(body.links) ? body.links : shopee.splitLinks(body.text);
  if (!links.length) throw new Error("วางลิงก์สินค้าก่อน");

  const saved = [];
  const failed = [];
  for (const link of links) {
    let parsed = shopee.parseProductLink(link);

    // A short link carries no ids — ask the extension to resolve it, then re-parse.
    if (!parsed.ok && parsed.short) {
      try {
        const resolved = await ext.command(ACTION.SHOPEE_PRODUCT, { resolveUrl: parsed.url }, 60_000);
        if (resolved?.url) parsed = shopee.parseProductLink(resolved.url);
      } catch (err) {
        failed.push({ link, reason: `ขยายลิงก์ย่อไม่ได้: ${err.message}` });
        continue;
      }
    }
    if (!parsed.ok) { failed.push({ link, reason: parsed.reason }); continue; }

    try {
      const payload = await ext.command(ACTION.SHOPEE_PRODUCT, {
        shopid: parsed.shopid, itemid: parsed.itemid, url: parsed.url,
      }, 90_000);
      const record = shopee.normaliseProduct({ ...payload, shopid: parsed.shopid, itemid: parsed.itemid });
      if (!record.name) throw new Error("Shopee ไม่ได้คืนรายละเอียดสินค้า (ล็อกอินหมดอายุ?)");
      saved.push(store.upsertProduct(record));
      store.log(`สแกนแล้ว: ${record.name.slice(0, 60)} (${record.images.length} รูป)`, "info", {
        stage: "scan.saved", productId: record.id, images: record.images.length, price: record.price,
      });
    } catch (err) {
      failed.push({ link, reason: err.message });
      store.log(`สแกนไม่สำเร็จ ${link}: ${err.message}`, "error");
    }
  }
  return { saved, failed };
}

function handleJobSubmit(body) {
  const ids = Array.isArray(body.productIds) ? body.productIds : [body.productId].filter(Boolean);
  if (!ids.length) throw new Error("เลือกสินค้าก่อน");

  const model = videoModel(body.videoModel || DEFAULT_VIDEO_MODEL);
  if (!model) throw new Error(`ไม่รู้จักโมเดล ${body.videoModel}`);

  // Above 1 concurrent queue, only R2V models are selectable (see runner.mjs's
  // header comment) — I2V's extra generateImage() call roughly doubles Flow traffic
  // per concurrent slot, and this is BlueSPite's own risk-reduction call, not ref1's.
  // "มีข้อความ" carries that same extra call for every model now too (runner.mjs's
  // runSceneImage), but the operator's explicit call is that concurrency is just a
  // "how many slots at once" setting and should work unrestricted for every text
  // mode — so unlike the model-id check below, textMode is deliberately NOT gated
  // here.
  const concurrency = Math.max(1, Number(store.settings().concurrency) || 1);
  const textMode = body.textMode === "noText" ? "noText" : DEFAULT_TEXT_MODE;
  if (concurrency > 1 && !CONCURRENT_SAFE_MODELS.includes(model.id)) {
    throw new Error(`ตั้งค่า "จำนวนคิวพร้อมกัน" ไว้ ${concurrency} — เลือกได้เฉพาะ Omni Flash หรือ Veo 3.1 Lite ฟรี (ลดจำนวนคิวพร้อมกันเหลือ 1 ถ้าจะใช้โมเดลอื่น)`);
  }

  const characterMode = body.characterMode === "consistent" ? "consistent" : "random";
  const sceneMode = body.sceneMode === "continuous" ? "continuous" : "independent";
  const sceneCount = Math.max(1, Math.min(sceneMode === "continuous" ? 3 : 10, Number(body.sceneCount) || 1));
  const sceneVideoPrompts = Array.isArray(body.sceneVideoPrompts)
    ? body.sceneVideoPrompts.slice(0, 10).map((prompt) => String(prompt || "").slice(0, 5000))
    : [];
  const created = [];
  for (const productId of ids) {
    const p = store.product(productId);
    if (!p) throw new Error(`ไม่พบสินค้า ${productId}`);
    created.push(store.addJob({
      status: JOB.QUEUED,
      productId,
      orderNumber: genOrderNumber(),
      title: p.name.slice(0, 70) || productId,
      thumb: p.images[0] || p.image || "",
      videoModel: model.id,
      imageModel: body.imageModel || DEFAULT_IMAGE_MODEL,
      aspect: body.aspect || "portrait",
      characterMode,
      sceneMode,
      sceneCount,
      sceneVideoPrompts,
      textMode,
      direction: body.direction || {},
      extraPrompt: String(body.extraPrompt || "").slice(0, 2000),
      referenceImages: (body.referenceImages || p.images).slice(0, 3),
      error: "",
    }));
  }
  store.log(`เพิ่มเข้าคิว ${created.length} งาน (${model.label} · ${sceneCount} ฉาก/งาน · ${sceneMode === "continuous" ? "Extended" : "อิสระ"})`, "info", {
    stage: "queue.add", videoModel: model.id, count: created.length, sceneCount, sceneMode, characterMode,
  });
  return { jobs: created };
}

async function route(req, res, url) {
  const p = url.pathname;

  // ---------------- extension channel ----------------
  if (p === "/ext/hello" && req.method === "POST") {
    const body = await readJsonBody(req);
    const status = ext.noteHello(body);
    if (body.flowTier) store.updateSettings({ flowTier: body.flowTier });
    pushState();
    return json(res, 200, { ok: true, status, service: SERVICE });
  }
  if (p === "/ext/poll" && req.method === "GET") {
    const cmd = await ext.poll();
    pushState();
    if (!cmd) return json(res, 200, { command: null });
    return json(res, 200, { command: cmd });
  }
  if (p === "/ext/result" && req.method === "POST") {
    const body = await readJsonBody(req);
    ext.settle(body);
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p === "/ext/status" && req.method === "POST") {
    const body = await readJsonBody(req);
    ext.noteSites(body.sites || {});
    if (body.flowTier) store.updateSettings({ flowTier: body.flowTier });
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p === "/ext/log" && req.method === "POST") {
    const body = await readJsonBody(req);
    store.log(`[ext] ${body.msg}`, body.level || "info");
    pushState();
    return json(res, 200, { ok: true });
  }

  // ---------------- web UI channel ----------------
  if (p === "/api/state" && req.method === "GET") return json(res, 200, snapshot());

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    uiClients.add(res);
    const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 20_000);
    req.on("close", () => { clearInterval(beat); uiClients.delete(res); });
    return undefined;
  }

  if (p === "/api/search" && req.method === "POST") {
    const out = await handleSearch(await readJsonBody(req));
    pushState();
    return json(res, 200, out);
  }
  if (p === "/api/scan" && req.method === "POST") {
    const out = await handleScan(await readJsonBody(req));
    pushState();
    return json(res, 200, out);
  }
  if (p === "/api/preview" && req.method === "POST") {
    // Live prompt preview for the Generate form — same builder the runner uses.
    const body = await readJsonBody(req);
    const product = store.product(body.productId);
    if (!product) throw new Error("เลือกสินค้าก่อน");
    return json(res, 200, buildPrompt({
      product,
      direction: body.direction || {},
      videoModel: body.videoModel || DEFAULT_VIDEO_MODEL,
      extraPrompt: body.extraPrompt || "",
      textMode: body.textMode === "noText" ? "noText" : DEFAULT_TEXT_MODE,
    }));
  }
  if (p === "/api/test-image" && req.method === "POST") {
    // Runs the REAL image-generation step (goes to Flow, costs whatever the model
    // costs) but nothing after it — no video, no queue entry. Purely so the
    // operator can see what the I2V start frame actually looks like before
    // committing a whole job to it.
    const body = await readJsonBody(req);
    const product = store.product(body.productId);
    if (!product) throw new Error("เลือกสินค้าก่อน");
    const out = await testGenerateImage({
      product, direction: body.direction || {},
      characterMode: body.characterMode === "consistent" ? "consistent" : "random",
      imageModel: body.imageModel, aspect: body.aspect || "portrait",
      extraPrompt: body.extraPrompt || "",
    });
    pushState();
    return json(res, 200, out);
  }
  if (p === "/api/products" && req.method === "DELETE") {
    const body = await readJsonBody(req);
    if (body.all) store.clearProducts();
    else store.deleteProduct(body.id);
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/jobs" && req.method === "POST") {
    const out = handleJobSubmit(await readJsonBody(req));
    pushState();
    return json(res, 200, out);
  }
  if (p === "/api/jobs" && req.method === "DELETE") {
    const body = await readJsonBody(req);
    store.clearJobs(body.ids || null);
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history" && req.method === "DELETE") {
    const body = await readJsonBody(req);
    const status = String(body.status || "");
    if (!["done", "failed", "cancelled"].includes(status)) {
      throw new Error(`ลบประวัติได้เฉพาะ done/failed/cancelled ทีละสถานะ (ได้รับ "${status}")`);
    }
    const removed = store.clearHistoryByStatus(status);
    pushState();
    return json(res, 200, { ok: true, removed });
  }
  if (p === "/api/jobs/cancel" && req.method === "POST") {
    const body = await readJsonBody(req);
    const j = store.job(body.id);
    if (!j) throw new Error("ไม่พบงานนี้");
    if (j.status === JOB.RUNNING) {
      const aborted = cancelJob(j.id);   // abort whatever Flow call is in flight right now
      if (aborted) {
        store.updateJob(j.id, { cancelRequested: true });
      } else {
        // No live AbortController for this job — it's orphaned (normally caught by
        // reconcileOrphanedJobs() at startup, but cover the case defensively too).
        // Nothing is actually running it, so there's nothing to signal; cancel it
        // directly instead of setting a flag that will never be checked.
        store.updateJob(j.id, { status: JOB.CANCELLED, cancelRequested: false, finishedAt: Date.now() });
      }
    } else {
      store.updateJob(j.id, { status: JOB.CANCELLED });
    }
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/jobs/retry" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.id) {
      const j = store.job(body.id);
      if (!j) throw new Error("ไม่พบงานนี้");
      store.updateJob(j.id, { status: JOB.QUEUED, error: "", cancelRequested: false });
    } else {
      // No id = "ลองใหม่ทั้งหมด" (retry all) — every currently-FAILED job, back to
      // queued. Matches clearJobs()'s own convention (no ids = act broadly).
      for (const j of store.jobs()) {
        if (j.status === JOB.FAILED) store.updateJob(j.id, { status: JOB.QUEUED, error: "", cancelRequested: false });
      }
    }
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/queue/run" && req.method === "POST") {
    const started = startQueue(pushState);
    pushState();
    return json(res, 200, { ok: true, started });
  }
  if (p === "/api/queue/stop" && req.method === "POST") {
    const stopping = requestStop();
    pushState();
    return json(res, 200, { ok: true, stopping });
  }
  if (p === "/api/settings" && req.method === "POST") {
    const out = store.updateSettings(await readJsonBody(req));
    pushState();
    return json(res, 200, out);
  }
  if (p === "/api/log" && req.method === "DELETE") {
    store.clearLog();
    pushState();
    return json(res, 200, { ok: true });
  }
  if (p.startsWith("/media/") && req.method === "GET") {
    return serveMedia(req, res, p);
  }

  return serveStatic(req, res, p);
}

// ------------------------------------------------------------------ bootstrap
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  // The extension origin is chrome-extension://…, so it needs CORS to reach us.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  route(req, res, url).catch((err) => {
    if (res.headersSent) return;
    store.log(`${req.method} ${url.pathname} — ${err.message}`, "error");
    pushState();
    json(res, 400, { error: err.message });
  });
});

function listen(port, attemptsLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`[bluespite] cannot listen: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.log(`\n  BlueSPite bridge  →  http://${HOST}:${port}`);
    console.log(`  โหลด extension แบบ unpacked จากโฟลเดอร์ extension/ แล้วเปิดลิงก์ด้านบน\n`);
    store.log(`Bridge listening on ${HOST}:${port}`);
  });
}

// Any job still "running" on disk at this point belongs to a bridge process that no
// longer exists — nothing can ever answer หยุด/ยกเลิก for it (see the doc comment on
// reconcileOrphanedJobs()), so it's cleared to "failed" before the queue runner or
// the UI can ever see it as live.
const reconciled = store.reconcileOrphanedJobs();
if (reconciled) store.log(`พบงานค้างจากบริดจ์ก่อนหน้า ${reconciled} งาน — ตั้งเป็นล้มเหลวแล้ว (กดลองใหม่ได้)`, "warn");

const startPort = Number(process.env.PORT || DEFAULT_PORT);
listen(startPort, PORT_SCAN_SPAN);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { store.flushNow(); process.exit(0); });
}

// Without these, ANY unhandled exception/rejection anywhere in the bridge (a bad
// await, an unexpected field shape, whatever) kills the whole process instantly and
// silently — no error handler existed at all before this. Doubly bad combined with
// start-bluespite.bat's `node server\server.mjs` having no `pause` after it: the
// window just closes the moment node exits, wiping the stack trace before anyone
// can read it — "the server keeps closing itself" with zero diagnostic trail. This
// can't make a crash survivable (the process state may be corrupted — still exits
// after), but it makes the LAST thing that happened durable: printed to the
// (now-paused, see start-bluespite.bat) terminal AND written to store's log file,
// which the web UI's Log dock can show even after the bridge is long dead.
function crashLog(label, err) {
  const message = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`\n[bridge] ${label}:\n${message}\n`);
  try { store.log(`Bridge ล้ม (${label}): ${err?.message || err}`, "error"); store.flushNow(); } catch { /* store itself may be what's broken */ }
  process.exitCode = 1;
  process.exit(1);
}
process.on("uncaughtException", (err) => crashLog("uncaughtException", err));
process.on("unhandledRejection", (err) => crashLog("unhandledRejection", err));
