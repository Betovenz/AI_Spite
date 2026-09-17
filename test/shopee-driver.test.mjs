// Exercises extension/src/content/shopee.js in a stubbed browser so the transport
// fallback (MAIN-world helper vs direct fetch) can be verified without Chrome.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "extension", "src", "content", "shopee.js"), "utf8");

function makeEnv({ withHelper, fetchImpl }) {
  const listeners = [];
  let messageHandler = null;   // set by chrome.runtime.onMessage.addListener

  const win = {
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
    postMessage(data) {
      // Deliver asynchronously, like a real postMessage.
      setTimeout(() => {
        for (const fn of listeners) fn({ source: win, data });
      }, 1);
    },
  };
  win.window = win;

  if (withHelper) {
    // Stand-in MAIN-world helper: answers probes, and serves requests from a table.
    win.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.tag !== "__bsp_shopee_req") return;
      const reply = (payload) => win.postMessage({ tag: "__bsp_shopee_res", id: msg.id, ...payload });
      if (msg.probe) return reply({ ok: true, probe: true, version: 2 });
      reply({ ok: true, json: { items: [{ item_basic: { itemid: 1, shopid: 2, name: "via-helper" } }] } });
    });
  }

  const chrome = {
    runtime: { onMessage: { addListener(fn) { messageHandler = fn; } } },
  };

  const sandbox = {
    window: win,
    location: { origin: "https://shopee.co.th", href: "https://shopee.co.th/" },
    chrome,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    console,
    URLSearchParams,
    Array,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Error,
    Object,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  return {
    send: (bsp, data) => new Promise((resolve) => messageHandler({ bsp, data }, null, resolve)),
  };
}

function fakeFetch(body, ok = true, status = 200) {
  return async (url) => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
    __url: url,
  });
}

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------- case 1
console.log("\ncase 1: MAIN-world helper present");
{
  const env = makeEnv({
    withHelper: true,
    fetchImpl: fakeFetch({ items: [{ item_basic: { itemid: 9, shopid: 9, name: "via-direct" } }] }),
  });
  const res = await env.send("shopee.search", { keyword: "หมอน", limit: 5 });
  const trace = res.__trace || [];
  check("no error", !res.__error, res.__error);
  check("probe recorded helper as alive", trace[0]?.ok === true && /helper พร้อม/.test(trace[0]?.info || ""), JSON.stringify(trace[0]));
  check("request went via helper", trace.some((t) => t.info === "via helper"), JSON.stringify(trace.map((t) => t.info)));
  check("used helper's payload", res.items?.[0]?.item_basic?.name === "via-helper", JSON.stringify(res.items?.[0]));
}

// ---------------------------------------------------------------- case 2
console.log("\ncase 2: helper MISSING (stale tab) -> direct fetch fallback");
{
  let fetched = "";
  const env = makeEnv({
    withHelper: false,
    fetchImpl: async (url) => {
      fetched = url;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ items: [{ item_basic: { itemid: 9, shopid: 9, name: "via-direct" } }] }),
      };
    },
  });
  const res = await env.send("shopee.search", { keyword: "หมอน", limit: 5 });
  const trace = res.__trace || [];
  check("no error (degraded, not failed)", !res.__error, res.__error);
  check("probe recorded helper as missing", trace[0]?.ok === false, JSON.stringify(trace[0]));
  check("request went via direct", trace.some((t) => t.info === "via direct"), JSON.stringify(trace.map((t) => t.info)));
  check("fetched ABSOLUTE www url", fetched.startsWith("https://shopee.co.th/api/v4/search/search_items"), fetched);
  check("used direct payload", res.items?.[0]?.item_basic?.name === "via-direct");
}

// ---------------------------------------------------------------- case 3
console.log("\ncase 3: Shopee returns HTML (login/captcha) -> reported clearly");
{
  const env = makeEnv({
    withHelper: false,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<!doctype html><html>login</html>" }),
  });
  const res = await env.send("shopee.search", { keyword: "x", limit: 5 });
  check("surfaces an error", Boolean(res.__error), res.__error);
  check("names the real cause", /ไม่ใช่ JSON/.test(res.__error || ""), res.__error);
  check("names the transport", /via direct/.test(res.__error || ""), res.__error);
  check("trace kept the failure", (res.__trace || []).some((t) => t.ok === false && t.error), JSON.stringify(res.__trace));
}

// ---------------------------------------------------------------- case 4
console.log("\ncase 4: HTTP 403 on the affiliate endpoint");
{
  const env = makeEnv({
    withHelper: false,
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => "forbidden" }),
  });
  const res = await env.send("shopee.offer", { items: [{ shopid: "1", itemid: "2" }] });
  check("surfaces HTTP 403", /403/.test(res.__error || ""), res.__error);
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
