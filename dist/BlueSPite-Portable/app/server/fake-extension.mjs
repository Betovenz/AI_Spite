// A stand-in for the Chrome extension, for testing the bridge without a browser.
//
//   node server/fake-extension.mjs [port]
//
// It speaks the exact same /ext/* protocol the real extension does and answers every
// command with canned data, so search -> scan -> queue -> run can be exercised
// end to end. Useful when changing the bridge or the prompt builder; it proves
// nothing about the real Shopee/Flow DOM.
//
// ALWAYS pass an explicit port that differs from your real bridge, e.g.
//   node server/server.mjs           # real bridge, picks 24242
//   PORT=24300 node server/server.mjs        # a second, throwaway bridge
//   node server/fake-extension.mjs 24300     # talks ONLY to the throwaway one
// Both a real bridge and this fake one write to the SAME data/bluespite.json by
// default (it's a project-relative path) — if two processes are both live against
// that file, the last one to flush wins and silently clobbers the other's state.
// Point this at a bridge you started yourself for testing, never at a bridge you
// don't own the lifecycle of.

import { DEFAULT_PORT, ACTION } from "../shared/protocol.mjs";

const PORT = Number(process.argv[2] || process.env.PORT || DEFAULT_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

// Matches Shopee's live "modern" search-card shape (item_card_displayed_asset +
// item_data), confirmed against ref3's own parser — see the comment above
// normaliseItem() in server/shopee.mjs. Using the real shape here is the whole point:
// a fake that used the old assumed shape masked the parsing bug this file exists to
// catch. rating/image are the two fields that shape does NOT confirm, so they are
// added as extra top-level keys here, matching how normaliseItem()'s defensive
// `pick()` search would find them if Shopee does put them at the item root.
const sample = (n) => ({
  item_card_displayed_asset: {
    name: `ชุดทดสอบ BlueSPite รุ่นที่ ${n} พร้อมส่ง`,
    display_price: {
      price: (120 + n * 37) * 100000,
      price_before_discount: (200 + n * 40) * 100000,
    },
  },
  item_data: {
    shopid: 5551, itemid: 9000 + n, ctime: 1700000000,
    label_ids: [],
    item_card_display_sold_count: {
      historical_sold_count_text: `${(4 * n * n / 10).toFixed(1)}พัน`,
      monthly_sold_count_text: String(12 * n),
    },
    stock: 300,
    liked_count: 40 * n,
    shop_name: `ร้านทดสอบ ${n}`,
    shop_location: "กรุงเทพมหานคร",
    shopee_verified: n % 3 === 0,
  },
  // Unverified field names (see the note above normaliseItem) — placed at item root,
  // which is the first spot pick() checks.
  image: `test-image-hash-${n}`,
  item_rating: { rating_star: 4 + (n % 10) / 10, rating_count: [5, 3, 8, 20, 60 * n] },
});

async function handle({ action, data }) {
  switch (action) {
    case ACTION.PING:
      return { pong: true, version: "fake" };

    case ACTION.STATUS:
      return { sites: { shopee: { ok: true, detail: "fake" }, flow: { ok: true, detail: "fake" } } };

    case ACTION.SHOPEE_SEARCH: {
      const count = Math.min(Number(data.limit) || 12, 12);
      return { items: Array.from({ length: count }, (_, i) => sample(i + 1)) };
    }

    case ACTION.SHOPEE_PRODUCT: {
      if (data.resolveUrl) return { url: "https://shopee.co.th/fake-i.5551.9001" };
      // Mirrors the FLAT shape extension/src/content/shopee.js's product() actually
      // returns (already reshaped from Shopee's PDP nesting) — not the search-card
      // shape sample() produces above. Keeping the two distinct is the point: a fake
      // that reused sample()'s shape here would hide a shape mismatch bug same as the
      // one this whole rewrite was chasing.
      const n = Number(String(data.itemid).slice(-1)) || 1;
      return {
        itemid: data.itemid,
        shopid: data.shopid,
        name: `ชุดทดสอบ BlueSPite รุ่นที่ ${n} พร้อมส่ง`,
        description: [
          "เนื้อบางเบา ซึมไว ไม่เหนียวเหนอะหนะ",
          "ใช้ได้ทั้งผิวหน้าและผิวกาย ทุกสภาพผิว",
          "ขนาดพกพา ใส่กระเป๋าได้สบาย",
          "ทักแชทได้ตลอด 24 ชม.",
        ].join("\n"),
        brand: "TestBrand",
        images: [`test-image-hash-${n}`, `test-image-hash-${n}b`],
        price: (120 + n * 37) * 100000,
        price_before_discount: (200 + n * 40) * 100000,
        stock: 300,
        item_rating: { rating_star: 4 + (n % 10) / 10, rating_count: [5, 3, 8, 20, 60 * n] },
        liked_count: 40 * n,
        shop_name: `ร้านทดสอบ ${n}`,
        shop_location: "กรุงเทพมหานคร",
        shopee_verified: n % 3 === 0,
        categories: [{ display_name: "ความงาม" }, { display_name: "ดูแลผิว" }],
        variations: [{ name: "ขนาด 30ml" }, { name: "ขนาด 50ml" }],
      };
    }

    case ACTION.SHOPEE_OFFER:
      return { rates: (data.items || []).map((it, i) => ({ ...it, rate: 3 + (i % 8) })) };

    case ACTION.FLOW_ENSURE_TAB:
      return { ok: true, hasComposer: true, tier: "x20" };

    // These two are the only things Flow generation still asks the EXTENSION for —
    // everything else (session, project, upload, generate, poll, resolve) runs
    // bridge-side against the REAL labs.google/aisandbox-pa APIs now
    // (server/flow-client.mjs). That means this fake extension can no longer fully
    // simulate a video-generation run end to end: a fake cookie/token here still
    // hits Google's real servers on the next hop and will fail there (as it should —
    // this file fakes the BROWSER side only). It's still useful for exercising
    // search -> scan -> queue -> "run reaches the harvest/mint step" without a
    // browser open.
    case ACTION.FLOW_HARVEST_COOKIES:
      return { cookieHeader: "next-auth.session-token=fake-not-a-real-session" };

    case ACTION.FLOW_MINT_CAPTCHA:
      return { token: "fake-recaptcha-token" };

    default:
      throw new Error(`fake extension does not implement ${action}`);
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  await post("/ext/hello", {
    installId: "fake-install",
    version: "fake",
    flowTier: "x20",
    sites: { shopee: { ok: true, detail: "fake" }, flow: { ok: true, detail: "fake" } },
  });
  console.log(`[fake-ext] connected to ${BASE}`);

  for (;;) {
    const res = await fetch(`${BASE}/ext/poll`);
    const { command } = await res.json();
    if (!command) continue;
    console.log(`[fake-ext] ${command.action}`);
    try {
      await post("/ext/result", { id: command.id, ok: true, result: await handle(command) });
    } catch (err) {
      await post("/ext/result", { id: command.id, ok: false, error: err.message });
    }
  }
}

main().catch((err) => {
  console.error(`[fake-ext] ${err.message}`);
  process.exit(1);
});
