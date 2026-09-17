// ISOLATED-world Flow driver. Relays two things to the MAIN-world reCAPTCHA minter
// (flow-api.js) over window.postMessage — same split as shopee.js/shopee-api.js,
// for the same reason: only a MAIN-world script sees the page's own `grecaptcha`.
//
// Everything else Flow generation needs (session token, project, upload, generate,
// poll, resolve) runs BRIDGE-SIDE via server/flow-client.mjs — see the header
// comment in flow-api.js for why. This file's only job is to answer
// background.js's flow.probe / flow.mintCaptcha commands.

(function () {
  // Tear down any earlier version's listeners outright — a version-number guard
  // alone only stops a same-or-older script from re-registering, it can't
  // deregister an ALREADY-ACTIVE older listener from an earlier injection this tab
  // session. Re-injection (chrome.scripting.executeScript, or a second
  // content_scripts match) lands in the SAME persistent page context, so old and
  // new listeners pile up side by side, and whichever answers first wins — usually
  // the stale one. Two listener types here (window message relay + the
  // chrome.runtime interface), both need replacing.
  if (typeof window.__bspFlowDriverOff === "function") window.__bspFlowDriverOff();

  const REQ = "__bsp_flow_req";
  const RES = "__bsp_flow_res";
  const pending = new Map();
  let seq = 0;

  function onWindowMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.tag !== RES || !pending.has(msg.id)) return;
    const { resolve, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    resolve(msg);
  }
  window.addEventListener("message", onWindowMessage);

  function call(action, data = {}, timeoutMs = 20_000) {
    seq += 1;
    const id = `${Date.now()}_${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${action} ไม่ตอบ (MAIN-world client อาจยังไม่ถูกฉีดเข้าไป — โหลดหน้า Flow ใหม่)`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      window.postMessage({ tag: REQ, id, action, data }, location.origin);
    }).then((msg) => {
      if (!msg.ok) throw new Error(msg.error);
      return msg.result;
    });
  }

  // "flow.mintCaptcha" used to be relayed through here too — background.js now
  // mints the reCAPTCHA token directly via chrome.scripting.executeScript
  // (world:"MAIN"), skipping this relay entirely (see background.js's
  // FLOW_MINT_CAPTCHA case for why).
  const HANDLERS = {
    "flow.probe": () => call("flow.probe", {}, 20_000),
  };

  function onRuntimeMessage(msg, _sender, respond) {
    const handler = HANDLERS[msg?.bsp];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(msg.data || {}))
      .then(respond)
      .catch((err) => respond({ __error: String(err?.message || err) }));
    return true;
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.__bspFlowDriverOff = () => {
    window.removeEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  };
})();
