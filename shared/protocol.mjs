// BlueSPite wire protocol — bridge <-> extension <-> web UI.
//
// MIRROR of extension/src/lib/protocol.js (the extension cannot import from outside its own root). Both files must stay identical in the
// values below (same rule ref1/ref2 use for their protocol pairs); only the module
// wrapper differs. If you add a message type or action, add it in BOTH files.

export const PROTOCOL_VERSION = 1;
export const SERVICE = "bluespite";

// The bridge binds loopback only and walks this range until it finds a free port.
// The extension scans the SAME range, so the two always rendezvous without config.
export const DEFAULT_PORT = 24242;
export const PORT_SCAN_SPAN = 20;

export const MSG = {
  // extension -> bridge
  EXT_HELLO: "ext.hello",
  EXT_STATUS: "ext.status",   // tab/login availability per site
  EXT_RESULT: "ext.result",   // reply to a COMMAND (correlated by id)
  EXT_ERROR: "ext.error",
  EXT_PROGRESS: "ext.progress",

  // bridge -> extension
  COMMAND: "ext.command",
  EXT_PING: "ext.ping",       // keepalive; receiving it also keeps the MV3 SW awake

  // web UI <-> bridge
  UI_HELLO: "ui.hello",
  UI_STATE: "ui.state",       // full snapshot (extension link, products, jobs, settings)
  LOG: "log",

  SEARCH_RUN: "search.run",         // UI -> bridge: run a Shopee keyword search
  SEARCH_RESULT: "search.result",
  SCAN_RUN: "scan.run",             // UI -> bridge: scan pasted product link(s)
  SCAN_RESULT: "scan.result",
  PRODUCT_DELETE: "product.delete",
  PRODUCT_CLEAR: "product.clear",

  JOB_SUBMIT: "job.submit",         // UI -> bridge: queue a generate job (does NOT auto-run)
  JOB_CANCEL: "job.cancel",
  JOB_RETRY: "job.retry",
  JOBS_CLEAR: "jobs.clear",
  QUEUE_RUN: "queue.run",
  QUEUE_STOP: "queue.stop",

  SETTINGS_UPDATE: "settings.update",
};

// Actions carried inside an MSG.COMMAND envelope. The extension dispatches on these.
export const ACTION = {
  PING: "ping",
  STATUS: "status",                 // which sites have a usable logged-in tab
  SHOPEE_SEARCH: "shopee.search",   // keyword -> ranked item list (api/v4/search/search_items)
  SHOPEE_PRODUCT: "shopee.product", // itemid/shopid -> full PDP detail (api/v4/pdp/get_pc)
  SHOPEE_OFFER: "shopee.offer",     // affiliate commission lookup (api/v3/offer/product/list)
  FLOW_ENSURE_TAB: "flow.ensureTab",
  // The actual Flow HTTP calls (session/project/upload/generate/poll/resolve) run
  // BRIDGE-SIDE now (server/flow-client.mjs, plain Node fetch — no CORS there at
  // all), not from the browser page. A cross-origin POST from inside the labs.google
  // tab to aisandbox-pa.googleapis.com carries an Authorization header, which
  // disqualifies it from being a CORS-simple request no matter the Content-Type —
  // real preflight always happens, and if that's rejected the browser's fetch()
  // fails as a bare, undiagnosable "Failed to fetch". ref1 sidesteps this
  // entirely by never doing that fetch IN the browser: it harvests the session
  // cookie + mints a reCAPTCHA token (the only two things that truly require a
  // real browser tab) and does the rest server-side. Same split here:
  FLOW_HARVEST_COOKIES: "flow.harvestCookies",  // bridge -> ext: labs.google session cookie, as a Cookie header string
  FLOW_MINT_CAPTCHA: "flow.mintCaptcha",        // bridge -> ext: { action } -> { token } via grecaptcha.enterprise in the real tab
  FLOW_REFRESH_CAPTCHA: "flow.refreshCaptcha",  // reload the Flow project context after unusual-activity rejection
  FLOW_EXTEND_SUBMIT: "flow.extendSubmit",      // submit the in-page fZytfe Extended-scene RPC
};

// Job lifecycle.
export const JOB = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

export function envelope(type, data = {}, id = "") {
  return { v: PROTOCOL_VERSION, service: SERVICE, type, id, data };
}
