// ISOLATED-world Shopee driver. Receives commands from the service worker, asks the
// MAIN-world helper (shopee-api.js) to do the actual fetch, and returns raw payloads.
//
// Endpoints are the ones ref3's Shop Tool uses against the same site:
//   /api/v4/search/search_items    keyword search
//   /api/v4/pdp/get_pc             product detail page
//   /api/v3/offer/product/list     affiliate commission (affiliate accounts only)
// Parsing/scoring is deliberately left to the bridge — this file stays a thin,
// auditable transport so a Shopee response-shape change is fixed in one place.

(function () {
  // Tear down any earlier version's listeners outright. Re-injection lands in the
  // SAME persistent page context, so an old listener from a previous version never
  // goes away on its own — a version-number guard only stops the NEW code from
  // double-installing, it doesn't remove the OLD installation, and whichever
  // listener answers first wins (usually the stale one). Two listener types here
  // (window message relay + the chrome.runtime interface), both need replacing.
  if (typeof window.__bspShopeeDriverOff === "function") window.__bspShopeeDriverOff();

  const REQ = "__bsp_shopee_req";
  const RES = "__bsp_shopee_res";
  // Search/PDP only work against the www origin — a relative fetch from
  // affiliate.shopee.co.th would hit the wrong host and 404.
  const API_ORIGIN = "https://shopee.co.th";
  const pending = new Map();
  let seq = 0;

  // Every API round trip is recorded and returned with the result, so the web UI's
  // log shows the real URL, HTTP outcome and item count instead of a bare failure.
  let trace = [];
  const note = (entry) => { trace.push({ ts: Date.now(), ...entry }); };

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

  // Is the MAIN-world helper present in this frame? Probed once, then cached for the
  // session. `null` = not probed yet.
  let helperAlive = null;

  function probeHelper(timeoutMs = 1500) {
    if (helperAlive !== null) return Promise.resolve(helperAlive);
    seq += 1;
    const id = `probe_${Date.now()}_${seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(false); }, timeoutMs);
      pending.set(id, { resolve: () => resolve(true), timer });
      window.postMessage({ tag: REQ, id, url: `${API_ORIGIN}/api/v4/pdp/get_pc?probe=1`, probe: true }, location.origin);
    }).then((alive) => {
      helperAlive = alive;
      note({ url: "(probe MAIN-world helper)", ok: alive, info: alive ? "helper พร้อม" : "helper ไม่มี — ใช้ fetch ตรงแทน" });
      return alive;
    });
  }

  /** Ask the MAIN-world helper to fetch. Resolves the helper's reply envelope. */
  function viaHelper(url, referer, timeoutMs) {
    seq += 1;
    const id = `${Date.now()}_${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("MAIN-world helper ไม่ตอบ"));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      window.postMessage({ tag: REQ, id, url, referer }, location.origin);
    });
  }

  /** Fetch straight from the content script. Same origin as the page, so cookies ride
   *  along; it just cannot benefit from any page-level request wiring the way the
   *  MAIN-world helper can. Used when the helper is absent (tab predates the
   *  extension) so a stale tab degrades instead of failing outright. */
  async function viaDirect(url, referer) {
    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json",
          "x-api-source": "pc",
          "x-requested-with": "XMLHttpRequest",
          "af-ac-enc-dat": "null",
        },
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, body: text.slice(0, 400) };
      try {
        return { ok: true, json: JSON.parse(text) };
      } catch {
        return { ok: false, error: "Shopee ตอบกลับไม่ใช่ JSON (อาจถูกขอ login/captcha)", body: text.slice(0, 400) };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** One GET, MAIN-world helper first with a direct fetch as the fallback. */
  async function apiGet(path, { referer = "", timeoutMs = 20_000 } = {}) {
    const url = path.startsWith("http") ? path : API_ORIGIN + path;
    const startedAt = Date.now();
    const useHelper = await probeHelper();

    let msg;
    let via = useHelper ? "helper" : "direct";
    if (useHelper) {
      try {
        msg = await viaHelper(url, referer, timeoutMs);
      } catch {
        // Helper answered the probe but not this call — fall through rather than fail.
        helperAlive = false;
        via = "direct (helper ค้าง)";
        msg = await viaDirect(url, referer);
      }
    } else {
      msg = await viaDirect(url, referer);
    }

    const ms = Date.now() - startedAt;
    if (!msg.ok) {
      note({ url, ok: false, error: msg.error, body: msg.body || "", ms, info: `via ${via}` });
      throw new Error(`${msg.error}${msg.body ? ` — ${msg.body}` : ""} [via ${via}]`);
    }
    note({ url, ok: true, ms, info: `via ${via}` });
    return msg.json;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ search
  // Shopee caps a search page at 60 items; anything larger is paged here.
  async function search({ keyword, limit = 60, newest = 0, minPrice = 0, maxPrice = 0 }) {
    const items = [];
    const pageSize = 60;
    let offset = Number(newest) || 0;

    while (items.length < limit) {
      const params = new URLSearchParams({
        by: "relevancy",
        keyword,
        limit: String(Math.min(pageSize, limit - items.length)),
        newest: String(offset),
        order: "desc",
        page_type: "search",
        scenario: "PAGE_GLOBAL_SEARCH",
        version: "2",
      });
      if (minPrice > 0) params.set("price_min", String(Math.round(minPrice * 100000)));
      if (maxPrice > 0) params.set("price_max", String(Math.round(maxPrice * 100000)));

      const json = await apiGet(`/api/v4/search/search_items?${params}`, {
        referer: `https://shopee.co.th/search?keyword=${encodeURIComponent(keyword)}`,
      });
      const batch = Array.isArray(json?.items) ? json.items : [];
      note({ url: `(page offset ${offset})`, ok: true, info: `ได้ ${batch.length} รายการ` });
      items.push(...batch);
      if (batch.length < pageSize) break;   // last page
      offset += pageSize;
      await sleep(600);                     // be a normal-looking client
    }
    return { items: items.slice(0, limit), keyword };
  }

  // ------------------------------------------------------------------ product
  async function product({ shopid, itemid }) {
    if (!shopid || !itemid) throw new Error("ต้องมี shopid และ itemid");
    const json = await apiGet(`/api/v4/pdp/get_pc?item_id=${itemid}&shop_id=${shopid}&detail_level=0`, {
      referer: `https://shopee.co.th/product/${shopid}/${itemid}`,
    });

    const data = json?.data;
    if (!data) throw new Error(json?.error_msg || "Shopee ไม่ได้คืนข้อมูลสินค้า");
    const item = data.item || data;

    // The image gallery is a SIBLING of `item`, not nested inside it — confirmed
    // against ref3's own PDP parser: `data.product_images.images`. A variation's own
    // photos live separately at `item.tier_variations[0].images`; used only if the
    // main gallery is somehow empty.
    const galleryImages = data.product_images?.images
      || item.tier_variations?.[0]?.images
      || [];

    // The PDP payload nests differently from search results, so flatten the fields
    // the bridge expects (it re-uses normaliseItem on whatever shape arrives).
    return {
      itemid: String(item.item_id ?? itemid),
      shopid: String(item.shop_id ?? shopid),
      name: item.title ?? item.name ?? "",
      description: item.description ?? "",
      brand: item.brand ?? item.brand_name ?? "",
      images: Array.isArray(galleryImages) ? galleryImages : [],
      image: Array.isArray(galleryImages) ? galleryImages[0] : "",
      price: item.price ?? item.price_min,
      price_before_discount: item.price_before_discount ?? 0,
      historical_sold: item.historical_sold ?? item.sold ?? 0,
      sold: item.sold ?? 0,
      stock: item.stock ?? 0,
      item_rating: item.item_rating ?? {},
      liked_count: item.liked_count ?? 0,
      shop_name: data.shop_detailed?.name ?? item.shop_name ?? "",
      shop_location: item.shop_location ?? "",
      shopee_verified: Boolean(data.shop_detailed?.is_official_shop),
      is_preferred_plus_seller: Boolean(data.shop_detailed?.is_preferred_plus_seller),
      categories: item.categories ?? [],
      variations: (item.tier_variations ?? []).flatMap((tier) => tier?.options ?? []),
    };
  }

  // ------------------------------------------------------------------ commission
  // Affiliate-only endpoint. A non-affiliate account gets an error here, which the
  // bridge treats as "no commission data" rather than a failed search.
  async function offer({ items = [] }) {
    const rates = [];
    const batches = [];
    for (let i = 0; i < items.length; i += 20) batches.push(items.slice(i, i + 20));

    for (const batch of batches) {
      const params = new URLSearchParams({
        item_id_list: batch.map((b) => b.itemid).join(","),
        shop_id_list: batch.map((b) => b.shopid).join(","),
        limit: String(batch.length),
      });
      try {
        const json = await apiGet(`/api/v3/offer/product/list?${params}`, {
          referer: "https://affiliate.shopee.co.th/",
        });
        for (const entry of json?.data?.list ?? json?.data ?? []) {
          rates.push({
            shopid: String(entry.shop_id ?? entry.shopid ?? ""),
            itemid: String(entry.item_id ?? entry.itemid ?? ""),
            rate: Number(entry.commission_rate ?? entry.rate ?? 0),
          });
        }
      } catch (err) {
        // Report once and stop — retrying a permissions failure per batch is noise.
        if (!rates.length) throw err;
        break;
      }
      await sleep(500);
    }
    return { rates };
  }

  const HANDLERS = {
    "shopee.search": search,
    "shopee.product": product,
    "shopee.offer": offer,
  };

  function onRuntimeMessage(msg, _sender, respond) {
    const handler = HANDLERS[msg?.bsp];
    if (!handler) return false;
    trace = [];
    const origin = location.origin;
    handler(msg.data || {})
      .then((result) => respond({ ...result, __trace: trace, __origin: origin }))
      .catch((err) => respond({ __error: String(err?.message || err), __trace: trace, __origin: origin }));
    return true;   // async response
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.__bspShopeeDriverOff = () => {
    window.removeEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  };
})();
