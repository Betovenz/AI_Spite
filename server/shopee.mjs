// Shopee link parsing and the product-analysis scoring used by the หาสินค้า page.
//
// No network access here — the extension does all fetching. This module only turns a
// pasted URL into {shopid, itemid} and turns raw item fields into a comparable score.

// Canonical PDP shapes:
//   https://shopee.co.th/<slug>-i.<shopid>.<itemid>
//   https://shopee.co.th/product/<shopid>/<itemid>
// Short links (s.shopee.co.th, shope.ee, shp.ee) carry no ids and must be resolved by
// the extension first — parseProductLink reports them as {short: true}.
const RE_I_FORM = /-i\.(\d+)\.(\d+)/;
const RE_PRODUCT_FORM = /\/product\/(\d+)\/(\d+)/;
const SHORT_HOSTS = new Set(["s.shopee.co.th", "shope.ee", "shp.ee", "s.shopee.com"]);

/**
 * @param {string} raw
 * @returns {{ok:boolean, shopid?:string, itemid?:string, short?:boolean, url?:string, reason?:string}}
 */
export function parseProductLink(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, reason: "ลิงก์ว่าง" };

  // Accept a bare "shopid.itemid" or "shopid/itemid" pair too — handy when copying
  // ids out of the search table.
  const bare = text.match(/^(\d{4,})[./](\d{4,})$/);
  if (bare) return { ok: true, shopid: bare[1], itemid: bare[2], url: pdpUrl(bare[1], bare[2]) };

  let url;
  try {
    url = new URL(text.startsWith("http") ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "รูปแบบลิงก์ไม่ถูกต้อง" };
  }

  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) return { ok: false, short: true, url: url.href, reason: "ลิงก์ย่อ — ต้องให้ Extension เปิดหาลิงก์จริงก่อน" };
  if (!/shopee\./.test(host)) return { ok: false, reason: `ไม่ใช่ลิงก์ Shopee (${host})` };

  const path = `${url.pathname}${url.search}`;
  const iForm = path.match(RE_I_FORM);
  if (iForm) return { ok: true, shopid: iForm[1], itemid: iForm[2], url: url.href };
  const pForm = path.match(RE_PRODUCT_FORM);
  if (pForm) return { ok: true, shopid: pForm[1], itemid: pForm[2], url: url.href };

  const qShop = url.searchParams.get("shopid");
  const qItem = url.searchParams.get("itemid");
  if (qShop && qItem) return { ok: true, shopid: qShop, itemid: qItem, url: url.href };

  return { ok: false, reason: "หา shopid/itemid ในลิงก์ไม่เจอ" };
}

export function pdpUrl(shopid, itemid) {
  return `https://shopee.co.th/product/${shopid}/${itemid}`;
}

/** Split a textarea of pasted links into individual candidates. */
export function splitLinks(text) {
  return String(text || "")
    .split(/[\s,\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------------ analysis
// Shopee returns prices in "micro" units (value * 100000). Everything downstream
// works in baht, so normalise once, here.
export function fromMicro(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n / 100000 : 0;
}

// Shopee's search cards report sold counts as pre-formatted Thai text, not a number
// ("1.2พัน", "500", "3หมื่น+") — confirmed against ref3's own live parser (Shop Tool's
// injected-script.min.js), which is the only ground truth we have for this endpoint's
// current shape. Order matters: check the biggest magnitude word first so "3.5แสน"
// doesn't get caught by a looser pattern.
const THAI_MAGNITUDE = [
  [/ล้าน/, 1_000_000],
  [/แสน/, 100_000],
  [/หมื่น/, 10_000],
  [/พัน/, 1_000],
  [/ร้อย/, 100],
];

export function parseThaiCount(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  for (const [re, mult] of THAI_MAGNITUDE) {
    if (re.test(s)) {
      const num = parseFloat(s.replace(re, "").replace(/,/g, "").trim());
      return Number.isFinite(num) ? Math.round(num * mult) : 0;
    }
  }
  const digits = s.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

/** First defined/non-empty value found by walking each dotted path in order. */
function pick(obj, paths) {
  for (const path of paths) {
    const val = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return undefined;
}

/**
 * Normalise one raw search/PDP item into the flat shape the UI and scorer use.
 * Unknown fields become 0/"" rather than undefined so the table never renders holes.
 *
 * Shopee has (at least) two live response shapes for a search card, and which one
 * a request gets back is not something we control:
 *   - "modern": item.item_card_displayed_asset + item.item_data (name/price live on
 *     the asset object, ids/sold-count text live on item_data)
 *   - "legacy": item.item_basic, with price/shopid/itemid flat on it
 * Both were confirmed against ref3's own parser (see THAI_MAGNITUDE above) — but
 * neither exposes a plain numeric sold count OR a documented image field for a search
 * card, only for the PDP endpoint. So `sold` here is Shopee's own rounded estimate
 * (parsed from its Thai-shorthand text), and `image`/`rating` are looked up across
 * every plausible key name defensively: if none match, they come back blank rather
 * than guessed, and describeRawItem() below can be logged to see the real keys.
 */
export function normaliseItem(raw = {}) {
  const asset = raw.item_card_displayed_asset;
  const data = raw.item_data;
  const modern = Boolean(asset && data);
  const legacy = modern ? null : (raw.item_basic || raw.item || raw);
  const soldCount = modern
    ? (data.item_card_display_sold_count || {})
    : (legacy?.item_card_display_sold_count || {});

  const shopid = String(pick(modern ? data : legacy, ["shopid", "shop_id"]) ?? raw.shopid ?? "");
  const itemid = String(pick(modern ? data : legacy, ["itemid", "item_id"]) ?? raw.itemid ?? "");
  const name = String(pick(modern ? asset : legacy, ["name", "title"]) ?? "").trim();

  const priceRaw = modern ? asset.display_price?.price : (legacy?.price ?? legacy?.price_min);
  const price = fromMicro(priceRaw);
  const priceBeforeRaw = pick(modern ? asset.display_price : legacy, [
    "price_before_discount", "original_price",
  ]);
  const priceBefore = fromMicro(priceBeforeRaw);

  const sold = parseThaiCount(pick(soldCount, ["historical_sold_count_text", "display_sold_count"]) ?? "0");
  const monthlySold = parseThaiCount(
    pick(soldCount, ["monthly_sold_count_text", "rounded_local_monthly_sold_count"]) ?? "0",
  );

  // A flat `raw.images` array is how the PDP payload (extension shopee.js `product()`)
  // carries the confirmed gallery (data.product_images.images) — search cards don't
  // have this, hence the defensive single-hash search below as a fallback source.
  const images = Array.isArray(raw.images) ? raw.images.map(imageUrl) : [];

  // No confirmed field name for a search card's thumbnail — try every plausible spot
  // across both shapes before giving up. imageUrl() is idempotent on a full URL.
  const imageHash = pick(raw, [
    "image", "images.0", "item_card_displayed_asset.image", "item_card_displayed_asset.images.0",
    "item_card_displayed_asset.cover_image", "item_data.image", "item_basic.image", "item_basic.images.0",
  ]);
  const ratingStar = pick(raw, [
    "item_rating.rating_star", "item_card_displayed_asset.item_rating.rating_star",
    "item_data.item_rating.rating_star", "item_basic.item_rating.rating_star",
  ]);
  const ratingCountRaw = pick(raw, [
    "item_rating.rating_count", "item_card_displayed_asset.item_rating.rating_count",
    "item_data.item_rating.rating_count", "item_basic.item_rating.rating_count",
  ]);

  return {
    id: `${shopid}_${itemid}`,
    shopid,
    itemid,
    name,
    url: pdpUrl(shopid, itemid),
    image: images[0] || (imageHash ? imageUrl(imageHash) : ""),
    images,
    price,
    priceBefore,
    discount: priceBefore > price && priceBefore > 0 ? Math.round((1 - price / priceBefore) * 100) : 0,
    sold,
    monthlySold,
    stock: Number(pick(modern ? data : legacy, ["stock"]) ?? 0) || 0,
    rating: Number(ratingStar ?? 0) || 0,
    ratingCount: Array.isArray(ratingCountRaw)
      ? ratingCountRaw.reduce((a, b) => a + (Number(b) || 0), 0)
      : Number(ratingCountRaw ?? 0) || 0,
    liked: Number(pick(modern ? data : legacy, ["liked_count"]) ?? 0) || 0,
    shopName: String(pick(modern ? data : legacy, ["shop_name"]) ?? raw.shop_name ?? "").trim(),
    shopLocation: String(pick(modern ? data : legacy, ["shop_location"]) ?? "").trim(),
    isOfficialShop: Boolean(pick(modern ? data : legacy, ["shopee_verified", "is_official_shop"])),
    isPreferredPlus: Boolean(pick(modern ? data : legacy, ["is_preferred_plus_seller"])),
    // Filled in by the affiliate lookup when the operator asks for it.
    commissionRate: Number(raw.commissionRate ?? 0) || 0,
  };
}

/**
 * One-line diagnostic of a raw search item's real shape — logged once per search so
 * a field that normaliseItem could not find (image/rating today) is one Log-dock
 * look away from a fix instead of a guess. Not used for any decision, only visibility.
 */
export function describeRawItem(raw = {}) {
  const asset = raw.item_card_displayed_asset;
  const shape = asset && raw.item_data ? "modern" : (raw.item_basic ? "legacy" : "unknown");
  const keysOf = (obj) => (obj && typeof obj === "object" ? Object.keys(obj).join(",") : "");
  return `shape=${shape} | root:[${keysOf(raw)}] | asset:[${keysOf(asset)}] | item_data:[${keysOf(raw.item_data)}] | item_basic:[${keysOf(raw.item_basic)}]`;
}

export function imageUrl(hash) {
  const h = String(hash || "").trim();
  if (!h) return "";
  if (h.startsWith("http")) return h;
  return `https://down-th.img.susercontent.com/file/${h}`;
}

// Score = weighted sum of four normalised signals, each mapped to 0..1 across the
// current result set. It is a *relative* ranking within one search, not an absolute
// quality claim — which is why the UI shows the component bars next to the total.
const SIGNALS = ["sales", "rating", "price", "commission"];

export function rankProducts(items, weights = {}) {
  const w = { sales: 1, rating: 1, price: 1, commission: 1, ...weights };
  if (!items.length) return [];

  const soldMax = Math.max(...items.map((i) => i.sold), 1);
  const prices = items.map((i) => i.price).filter((p) => p > 0);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const commMax = Math.max(...items.map((i) => i.commissionRate), 0);

  const scored = items.map((item) => {
    // Sales: log-scaled — the gap between 10 and 100 sold matters far more than
    // between 10,000 and 10,100.
    const sales = Math.log10(item.sold + 1) / Math.log10(soldMax + 1);
    // Rating: only trust it once there are enough reviews; ramp confidence to 30.
    const confidence = Math.min(item.ratingCount / 30, 1);
    const rating = item.rating > 0 ? (item.rating / 5) * confidence : 0;
    // Price: cheaper is better within this result set (impulse-buy bias for shorts).
    const price = priceMax > priceMin && item.price > 0
      ? 1 - (item.price - priceMin) / (priceMax - priceMin)
      : item.price > 0 ? 0.5 : 0;
    const commission = commMax > 0 ? item.commissionRate / commMax : 0;

    const parts = { sales, rating, price, commission };
    const totalWeight = SIGNALS.reduce((sum, k) => sum + (w[k] || 0), 0) || 1;
    const score = SIGNALS.reduce((sum, k) => sum + (w[k] || 0) * parts[k], 0) / totalWeight;

    return { ...item, signals: parts, score: Math.round(score * 1000) / 1000 };
  });

  return scored.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ PDP detail
// Turn the extension's PDP payload into the product record the generator consumes.
// The images list is the important part: those exact URLs become Flow's reference
// images, so the generated clip shows the real product.
export function normaliseProduct(payload = {}) {
  const base = normaliseItem(payload);
  const description = String(payload.description ?? "").trim();

  return {
    ...base,
    description,
    brand: String(payload.brand ?? "").trim(),
    category: (payload.categories || []).map((c) => String(c?.display_name ?? c ?? "").trim()).filter(Boolean).join(" > "),
    variations: (payload.variations || []).map((v) => String(v?.name ?? v ?? "").trim()).filter(Boolean),
    sellingPoints: sellingPoints(description),
    images: base.images.length ? base.images : (base.image ? [base.image] : []),
  };
}

// Pull short, prompt-usable bullets out of a Shopee description. Shopee sellers write
// walls of text with emoji bullets; we want the few lines that read like features.
export function sellingPoints(description) {
  return String(description || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\-•*▪️✅✔️🔹🔸👉📌⭐️★>]+/u, "").trim())
    .filter((line) => line.length >= 8 && line.length <= 120)
    .filter((line) => !/^https?:/i.test(line))
    .filter((line) => !/(line id|โทร|facebook|ไอดีไลน์|ทักแชท)/i.test(line))
    .slice(0, 8);
}
