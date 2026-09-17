// MAIN-world Shopee fetch helper.
//
// Why this exists: Shopee's /api/v4 endpoints reject requests that don't look like
// they came from its own client. Running the fetch in the page context means the
// page's cookies, referer and any client-side header wiring apply. The ISOLATED-world
// driver (shopee.js) cannot do that, so it posts requests here and awaits a reply.
//
// This file only forwards requests — it does not decide what to fetch. Only messages
// carrying our own namespaced tag are honoured, and only Shopee URLs are fetched.

(function () {
  // Tear down any earlier version's listener outright, rather than just guarding
  // against re-registering the SAME version. Re-injection (chrome.scripting.
  // executeScript) lands in the SAME persistent page context, so an old listener
  // from a previous version never goes away on its own — a version-number guard
  // only stops the NEW code from double-installing, it doesn't remove the OLD
  // installation, so both would answer and whichever fires first wins (usually the
  // stale one). Confirmed as a real bug in flow-api.js's sibling — see its comment.
  if (typeof window.__bspShopeeApiOff === "function") window.__bspShopeeApiOff();

  const REQ = "__bsp_shopee_req";
  const RES = "__bsp_shopee_res";

  function allowed(url) {
    try {
      const u = new URL(url, location.origin);
      return /(^|\.)shopee\.co\.th$/.test(u.hostname) && u.pathname.startsWith("/api/");
    } catch {
      return false;
    }
  }

  async function onMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.tag !== REQ || typeof msg.url !== "string") return;

    const reply = (payload) => window.postMessage({ tag: RES, id: msg.id, ...payload }, location.origin);

    // A liveness probe: answer without issuing a request, so the driver can find out
    // whether this helper exists before committing to it as the transport.
    if (msg.probe) return reply({ ok: true, probe: true });

    if (!allowed(msg.url)) return reply({ ok: false, error: `blocked url: ${msg.url}` });

    try {
      const res = await fetch(msg.url, {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json",
          "x-api-source": "pc",
          "x-requested-with": "XMLHttpRequest",
          "af-ac-enc-dat": "null",
          referer: msg.referer || location.href,
        },
      });
      const text = await res.text();
      if (!res.ok) return reply({ ok: false, error: `HTTP ${res.status}`, body: text.slice(0, 400) });
      try {
        reply({ ok: true, json: JSON.parse(text) });
      } catch {
        reply({ ok: false, error: "Shopee ตอบกลับไม่ใช่ JSON (อาจถูกขอ login/captcha)", body: text.slice(0, 400) });
      }
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  }
  window.addEventListener("message", onMessage);
  window.__bspShopeeApiOff = () => window.removeEventListener("message", onMessage);
})();
