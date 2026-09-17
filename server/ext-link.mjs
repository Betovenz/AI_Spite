// The extension link: every request that touches shopee.co.th or labs.google leaves
// this process as a *command* that the BlueSPite extension executes inside the
// operator's own logged-in tab, and comes back as a *result*. The bridge never calls
// a provider directly — that is the whole point of the extension being the middleman.
//
// Transport is HTTP long-poll rather than a WebSocket. ref1/ref2 both use WS plus a
// keepalive ping to fight the MV3 service-worker shutdown; long-poll gets the same
// latency with no framing code and no dependency, and a dropped poll is simply
// re-issued by the worker's alarm. The extension holds one open GET /ext/poll; the
// bridge answers it the moment a command is queued (or with 204 after a timeout).

import { randomUUID } from "node:crypto";
import { log } from "./store.mjs";

const POLL_TIMEOUT_MS = 25_000;      // below Chrome's ~30s fetch idle comfort zone
const DEFAULT_CMD_TIMEOUT_MS = 90_000;
const PRESENCE_TTL_MS = 60_000;      // no poll/result within this window => offline

/** @type {Map<string, {resolve:Function, reject:Function, timer:any, action:string, sentAt:number}>} */
const pending = new Map();
/** @type {Array<{id:string, action:string, data:object, queuedAt:number}>} */
const outbox = [];
/** @type {Array<{resolve:Function, timer:any}>} */
const waitingPolls = [];

const presence = {
  lastSeen: 0,
  installId: "",
  version: "",
  sites: {},   // { shopee: {ok, detail}, flow: {ok, detail} }
};

export function extStatus() {
  const online = Date.now() - presence.lastSeen < PRESENCE_TTL_MS;
  return {
    online,
    lastSeen: presence.lastSeen,
    installId: presence.installId,
    version: presence.version,
    sites: presence.sites,
    queued: outbox.length,
    inFlight: pending.size,
  };
}

export function noteHello({ installId = "", version = "", sites = {} } = {}) {
  const firstContact = !presence.lastSeen;
  presence.lastSeen = Date.now();
  if (installId) presence.installId = installId;
  if (version) presence.version = version;
  if (sites && typeof sites === "object") presence.sites = { ...presence.sites, ...sites };
  if (firstContact) log(`Extension connected (v${presence.version || "?"})`);
  return extStatus();
}

export function noteSites(sites = {}) {
  presence.lastSeen = Date.now();
  presence.sites = { ...presence.sites, ...sites };
}

// ------------------------------------------------------------------ dispatch
/**
 * Queue a command for the extension and resolve with its result.
 * Rejects on extension error, timeout, or if no extension has ever polled.
 *
 * `signal` (optional) lets a caller cancel while still WAITING on this command —
 * the runner passes each job's own AbortController signal so "ยกเลิก"/"หยุด" reject
 * immediately instead of waiting out the command's up-to-90s timeout. This only
 * stops the BRIDGE from waiting; a command already mid-flight in the extension
 * isn't told to stop (that side has no cancel channel), but any late `settle()`
 * for an aborted id is a harmless no-op below (the entry is already gone).
 */
export function command(action, data = {}, timeoutMs = DEFAULT_CMD_TIMEOUT_MS, signal) {
  if (!extStatus().online) {
    return Promise.reject(new Error("ยังไม่ได้เชื่อมต่อ BlueSPite Extension — เปิด Chrome และโหลด extension ก่อน"));
  }
  if (signal?.aborted) return Promise.reject(new Error("ยกเลิกโดยผู้ใช้"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("ยกเลิกโดยผู้ใช้"));
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`คำสั่ง ${action} หมดเวลา (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { signal?.removeEventListener("abort", onAbort); resolve(v); },
      reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
      timer, action, sentAt: Date.now(),
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    outbox.push({ id, action, data, queuedAt: Date.now() });
    drainPolls();
  });
}

// Hand every queued command to the first waiting poll. One command per poll response
// keeps the extension's dispatch loop trivial and errors attributable.
function drainPolls() {
  while (outbox.length && waitingPolls.length) {
    const poll = waitingPolls.shift();
    clearTimeout(poll.timer);
    poll.resolve(outbox.shift());
  }
}

/** Long-poll: resolves with a command, or null when the window expires. */
export function poll() {
  presence.lastSeen = Date.now();
  if (outbox.length) return Promise.resolve(outbox.shift());
  return new Promise((resolve) => {
    const entry = { resolve: null, timer: null };
    entry.resolve = resolve;
    entry.timer = setTimeout(() => {
      const idx = waitingPolls.indexOf(entry);
      if (idx >= 0) waitingPolls.splice(idx, 1);
      resolve(null);
    }, POLL_TIMEOUT_MS);
    waitingPolls.push(entry);
  });
}

/** Extension reports a command result (ok) or failure (error). */
export function settle({ id, ok, result, error }) {
  presence.lastSeen = Date.now();
  const entry = pending.get(id);
  if (!entry) return false;   // already timed out — nothing to settle
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(result ?? {});
  else entry.reject(new Error(String(error || `${entry.action} ล้มเหลว`)));
  return true;
}

/** Fail everything in flight — used when the extension reports a hard reset. */
export function abortAll(reason = "extension reset") {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
  outbox.length = 0;
}
