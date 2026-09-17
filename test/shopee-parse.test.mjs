// Regression test for server/shopee.mjs's item normaliser against the TWO live
// Shopee search-card shapes, confirmed by reading ref3's own parser (Shop Tool's
// injected-script.min.js — the only ground truth available, since Shopee documents
// none of this). See the comment above normaliseItem() in shopee.mjs for the exact
// source lines this was read from.
//
// This exists because a real search returned all-zero prices/sold-counts and blank
// thumbnails: the original normaliseItem() assumed a `item_basic` wrapper with plain
// numeric `historical_sold`/`price` fields, which turned out to be the LEGACY shape —
// live traffic is mostly the "modern" shape below, where price lives under
// `item_card_displayed_asset.display_price.price` and sold counts are pre-formatted
// Thai text ("1.2พัน"), not numbers.

import { normaliseItem, normaliseProduct, parseThaiCount } from "../server/shopee.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

console.log("\nparseThaiCount");
check("plain digits", parseThaiCount("523") === 523);
check("comma digits", parseThaiCount("1,234") === 1234);
check("พัน (thousand)", parseThaiCount("1.2พัน") === 1200);
check("หมื่น (ten-thousand)", parseThaiCount("3หมื่น") === 30000);
check("แสน (hundred-thousand)", parseThaiCount("2.5แสน") === 250000);
check("empty/zero", parseThaiCount("0") === 0 && parseThaiCount("") === 0 && parseThaiCount(undefined) === 0);

// ---------------------------------------------------------------- modern shape
console.log("\nnormaliseItem — modern shape (item_card_displayed_asset + item_data)");
{
  const raw = {
    item_card_displayed_asset: {
      name: "หมอนหนุนคอ เมมโมรี่โฟม",
      display_price: { price: 29900000 },   // 299.00 baht in micro units
    },
    item_data: {
      shopid: 5551, itemid: 90011, ctime: 1700000000,
      label_ids: [],
      item_card_display_sold_count: {
        historical_sold_count_text: "1.2พัน",
        monthly_sold_count_text: "350",
      },
    },
  };
  const item = normaliseItem(raw);
  check("id built from item_data ids", item.id === "5551_90011", item.id);
  check("name from asset", item.name === "หมอนหนุนคอ เมมโมรี่โฟม");
  check("price converted from micro", item.price === 299, String(item.price));
  check("historical sold parsed from Thai text", item.sold === 1200, String(item.sold));
  check("monthly sold parsed", item.monthlySold === 350, String(item.monthlySold));
  check("url built", item.url === "https://shopee.co.th/product/5551/90011", item.url);
}

// ---------------------------------------------------------------- legacy shape
console.log("\nnormaliseItem — legacy shape (item_basic)");
{
  const raw = {
    item_basic: {
      shopid: 777, itemid: 8899, name: "เสื่อโยคะกันลื่น",
      price: 45000000,
      item_card_display_sold_count: {
        display_sold_count: "2หมื่น",
        rounded_local_monthly_sold_count: "900",
      },
    },
  };
  const item = normaliseItem(raw);
  check("id from item_basic", item.id === "777_8899", item.id);
  check("name from item_basic", item.name === "เสื่อโยคะกันลื่น");
  check("price converted", item.price === 450, String(item.price));
  check("sold parsed from display_sold_count", item.sold === 20000, String(item.sold));
  check("monthly sold parsed", item.monthlySold === 900, String(item.monthlySold));
}

// ---------------------------------------------------------------- unknown/blank
console.log("\nnormaliseItem — unrecognised shape degrades to blanks, not a throw");
{
  const item = normaliseItem({ weird: "shape" });
  check("does not throw, returns an object", typeof item === "object");
  check("price is 0", item.price === 0);
  check("name is empty string", item.name === "");
  check("image is empty string, not undefined", item.image === "");
}

// ---------------------------------------------------------------- PDP shape
console.log("\nnormaliseProduct — flattened PDP payload from the content script");
{
  // This is the shape extension/src/content/shopee.js's product() hands to the
  // bridge: already flattened, with `images` sourced from data.product_images.images
  // (a SIBLING of item, not nested inside it — the second bug this fix covers).
  const payload = {
    itemid: "90011", shopid: "5551",
    name: "หมอนหนุนคอ เมมโมรี่โฟม", description: "นุ่มสบาย\nรองรับคอได้ดี\nซักได้",
    brand: "TestBrand",
    images: ["hash-main", "hash-2"],
    image: "",
    price: 29900000, price_before_discount: 0,
    categories: [{ display_name: "ของใช้ในบ้าน" }],
    variations: [{ name: "สีฟ้า" }],
  };
  const product = normaliseProduct(payload);
  check("images mapped to full URLs", product.images[0] === "https://down-th.img.susercontent.com/file/hash-main", product.images[0]);
  check("image falls back to first gallery image", product.image === product.images[0]);
  check("selling points extracted from description", product.sellingPoints.length === 2, JSON.stringify(product.sellingPoints));
  check("category joined", product.category === "ของใช้ในบ้าน");
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
