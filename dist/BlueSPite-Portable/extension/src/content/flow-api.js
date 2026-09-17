// MAIN-world Google Flow client — reCAPTCHA minting ONLY.
//
// The full direct-API HTTP client (session/project/upload/generate/poll/resolve)
// used to live here and call aisandbox-pa.googleapis.com straight from this page.
// That failed in testing with a bare, undiagnosable "Failed to fetch": the sandbox
// calls carry an Authorization header, which disqualifies them from being a
// CORS-simple request regardless of Content-Type — a real preflight always
// happens, and when it's rejected the browser's fetch() gives page JS zero detail
// (DNS failure, network drop, and a rejected preflight are all indistinguishable
// from inside fetch() by design).
//
// ref1's own architecture (bridge/character-flow.mjs, extension/src/background.js)
// never does that fetch from the browser either — it harvests the labs.google
// session cookie and mints a reCAPTCHA token (the only two things that truly
// require a live, logged-in page: grecaptcha.enterprise only exists on the real
// page, and NextAuth's session cookie is HttpOnly so page JS can't even read it —
// only the extension's chrome.cookies API can), then does every actual HTTP call
// server-side, where there is no CORS concept at all. server/flow-client.mjs is
// that Node-side client now; this file's job shrank to match ref1's split.
//
// grecaptcha.enterprise itself needs no import — Flow's own UI already loads it
// on this page, so calling it here is a direct, in-page call.

(function () {
  // Tear down any earlier version's listener outright, rather than just guarding
  // against re-registering the SAME version. A version-number guard alone cannot
  // deregister an already-active OLDER listener from an earlier injection this tab
  // session (chrome.scripting.executeScript re-injects into the SAME persistent
  // page context, so old and new listeners pile up side by side) — and whichever
  // one answers first wins the race even when it's the stale one. This bit us
  // directly: an old flow-api.js (from before the sandbox-fetch → bridge-client
  // rewrite) kept answering "unknown flow action: flow.mintCaptcha" because it
  // replied before the newly-injected version got a chance to.
  if (typeof window.__bspFlowApiOff === "function") window.__bspFlowApiOff();

  const REQ = "__bsp_flow_req";
  const RES = "__bsp_flow_res";

  // "flow.mintCaptcha" used to be handled here — background.js now mints the
  // reCAPTCHA token directly via chrome.scripting.executeScript (world:"MAIN"),
  // skipping this postMessage relay entirely (see background.js's
  // FLOW_MINT_CAPTCHA case for why).
  const HANDLERS = {
    "flow.probe": async () => ({ ok: true, hasRecaptcha: typeof grecaptcha !== "undefined" && Boolean(grecaptcha.enterprise) }),
  };

  async function onMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.tag !== REQ) return;
    const handler = HANDLERS[msg.action];
    const reply = (payload) => window.postMessage({ tag: RES, id: msg.id, ...payload }, location.origin);
    if (!handler) return reply({ ok: false, error: `unknown flow action: ${msg.action}` });
    try {
      reply({ ok: true, result: await handler(msg.data || {}) });
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  }
  window.addEventListener("message", onMessage);
  window.__bspFlowApiOff = () => window.removeEventListener("message", onMessage);
})();
