// BlueSPite service worker: the only component that talks to both the local bridge
// and the provider tabs. It owns the poll loop, finds/creates the right tab for each
// command, and forwards the command to that tab's content script.

import { ACTION } from "./lib/protocol.js";
import * as bridge from "./lib/bridge.js";

const VERSION = chrome.runtime.getManifest().version;
const SHOPEE_URL = "https://shopee.co.th/";
const FLOW_URL = "https://flow.google.com/";
const LABS_CONNECT_URL = "https://labs.google/fx/tools/flow";
const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

// MV3 stops an idle worker after ~30s. The alarm wakes it back up and the loop
// re-establishes itself; nothing is lost because pending commands live on the bridge.
const KEEPALIVE_MINUTES = 0.5;

let looping = false;

async function installId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}

async function siteStatus() {
  const [api, any, flow] = await Promise.all([
    chrome.tabs.query({ url: ["https://shopee.co.th/*", "https://www.shopee.co.th/*"] }),
    chrome.tabs.query({ url: ["https://shopee.co.th/*", "https://*.shopee.co.th/*"] }),
    chrome.tabs.query({ url: ["https://labs.google/*", "https://flow.google.com/*"] }),
  ]);
  // Only a www tab can serve the API calls; an affiliate-only tab is reported as such
  // so the UI does not claim readiness it does not have.
  const shopeeDetail = api.length
    ? `${api.length} แท็บ`
    : any.length ? "มีแต่แท็บ affiliate" : "ไม่มีแท็บ Shopee";
  return {
    shopee: { ok: api.length > 0, detail: shopeeDetail },
    flow: { ok: flow.length > 0, detail: flow.length ? `${flow.length} แท็บ` : "ไม่มีแท็บ Flow" },
  };
}

async function ensureConnected() {
  await bridge.restorePort();
  const port = await bridge.connect({
    installId: await installId(),
    version: VERSION,
    sites: await siteStatus(),
  });
  await chrome.storage.local.set({ connected: Boolean(port), bridgePort: port });
  await setBadge(port ? "" : "!");
  return port;
}

async function setBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: text ? "#d93025" : "#1a73e8" });
  } catch { /* action may be unavailable during startup */ }
}

// ------------------------------------------------------------------ tab plumbing
/** Find a tab matching `patterns`, or open `url` and wait for it to finish loading. */
async function ensureTab(patterns, url, { activate = false } = {}) {
  const found = await chrome.tabs.query({ url: patterns });
  if (found.length) {
    const tab = found.find((t) => t.status === "complete") || found[0];
    if (activate) await chrome.tabs.update(tab.id, { active: true });
    return tab;
  }
  const tab = await chrome.tabs.create({ url, active: activate });
  await waitForComplete(tab.id);
  return tab;
}

async function waitForComplete(tabId, timeoutMs = 45_000) {
  try {
    const current = await chrome.tabs.get(tabId);
    if (current.status === "complete") {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return current;
    }
  } catch {
    throw new Error("แท็บถูกปิดระหว่างรอโหลด");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("แท็บโหลดไม่เสร็จภายในเวลาที่กำหนด"));
    }, timeoutMs);
    function listener(id, info) {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      // The content script needs a moment after "complete" to register its listener.
      setTimeout(resolve, 800);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Send a message to a tab's content script, retrying once after re-injection.
 *  Content scripts report failure as `{__error}` (an exception cannot cross the
 *  message boundary), so unwrap that back into a real rejection here.
 *
 *  `mainFiles` matters: a tab that was already open when the extension loaded has
 *  NO content scripts at all, and re-injecting only the ISOLATED ones leaves the
 *  MAIN-world fetch helper missing — which surfaces later as "helper ไม่ตอบ"
 *  rather than as the injection problem it actually is. Inject both worlds. */
async function askTab(tabId, message, { files = [], mainFiles = [] } = {}) {
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!files.length) throw new Error(`ติดต่อ content script ไม่ได้: ${err.message}`);
    await injectAll(tabId, files, mainFiles);
    reply = await chrome.tabs.sendMessage(tabId, message);
  }
  await reportTrace(reply);
  if (reply && reply.__error) throw new Error(reply.__error);
  if (reply === undefined) throw new Error("content script ไม่ตอบกลับ");
  return reply;
}

/** Forward a content script's per-request trace to the bridge log, success or not —
 *  this is how the web UI can show whether the API call actually happened. */
async function reportTrace(reply) {
  const trace = reply?.__trace;
  if (!Array.isArray(trace) || !trace.length) return;
  if (reply.__origin) await bridge.sendLog(`ยิง API จาก ${reply.__origin}`, "debug");
  for (const entry of trace) {
    const ms = entry.ms != null ? ` (${entry.ms}ms)` : "";
    const tag = entry.label ? `[${entry.label}] ` : "";
    if (entry.ok) {
      await bridge.sendLog(`${tag}✓ ${entry.url}${ms}${entry.info ? ` — ${entry.info}` : ""}`, "debug");
    } else {
      await bridge.sendLog(`${tag}✗ ${entry.url}${ms} — ${entry.error}${entry.body ? ` | ${entry.body}` : ""}`, "error");
    }
  }
}

async function injectAll(tabId, files, mainFiles) {
  if (mainFiles.length) {
    await chrome.scripting.executeScript({ target: { tabId }, files: mainFiles, world: "MAIN" });
  }
  if (files.length) {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  }
  await new Promise((r) => setTimeout(r, 600));
}

const SHOPEE_FILES = ["src/content/shopee.js"];
const SHOPEE_MAIN_FILES = ["src/content/shopee-api.js"];
const FLOW_FILES = ["src/content/flow.js"];
const FLOW_MAIN_FILES = ["src/content/flow-api.js"];
// Search and PDP live on the www origin. affiliate.shopee.co.th matches the manifest
// too, but a relative /api/v4/… fetch from there hits the WRONG host — so the API tab
// must be a www one specifically, and the affiliate tab is only used for commissions.
const SHOPEE_PATTERNS = ["https://shopee.co.th/*", "https://www.shopee.co.th/*"];
const SHOPEE_ANY_PATTERNS = ["https://shopee.co.th/*", "https://*.shopee.co.th/*"];
const FLOW_PATTERNS = ["https://labs.google/*", "https://flow.google.com/*"];
const FLOW_PROJECT_URL_PREFIX = "https://flow.google.com/project/";
const FLOW_PROJECT_ID = /^[A-Za-z0-9-]{8,64}$/;
const FLOW_TAB_WARMUP_MS = 15_000;

let flowTabId = null;
let flowTabCreating = null;
let flowTabRefreshing = null;

function flowProjectUrl(projectId) {
  const value = String(projectId || "").trim();
  return FLOW_PROJECT_ID.test(value) ? `${FLOW_PROJECT_URL_PREFIX}${value}` : "";
}

function isFlowTabUrl(url) {
  const value = String(url || "");
  if (value.includes("accounts.google.com")) return false;
  return value.includes("labs.google/fx") || value.startsWith(FLOW_URL);
}

function isFlowMarketingUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "flow.google.com" && parsed.pathname.startsWith("/about");
  } catch {
    return false;
  }
}

function isOnAnyFlowProject(url) {
  return String(url || "").startsWith(FLOW_PROJECT_URL_PREFIX);
}

function isOnLabsConnectPage(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "labs.google" && parsed.pathname.startsWith("/fx/tools/flow");
  } catch {
    return false;
  }
}

async function findFlowTab() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => Number.isInteger(tab.id) && isFlowTabUrl(tab.url))
    .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0] || null;
}

async function closeOtherFlowTabs(keepTabId = null) {
  const tabs = await chrome.tabs.query({});
  const staleTabIds = tabs
    .filter((tab) => Number.isInteger(tab.id) && tab.id !== keepTabId && isFlowTabUrl(tab.url))
    .map((tab) => tab.id);
  await Promise.allSettled(staleTabIds.map((tabId) => chrome.tabs.remove(tabId)));
}

async function reviveFlowTabIfNeeded(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  let unavailable = tab.discarded === true || tab.frozen === true;
  if (!unavailable) {
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => document.readyState,
      });
      const readyState = out?.[0]?.result;
      unavailable = readyState !== "interactive" && readyState !== "complete";
    } catch {
      unavailable = true;
    }
  }
  if (!unavailable) return false;
  await chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
  await waitForComplete(tabId);
  await wait(FLOW_TAB_WARMUP_MS);
  return true;
}

async function parkFlowTabOnProject(tabId, projectId) {
  const wanted = flowProjectUrl(projectId);
  if (!wanted) return false;
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (isOnAnyFlowProject(current?.url)) return false;
  await chrome.tabs.update(tabId, { url: wanted });
  await waitForComplete(tabId);
  await wait(FLOW_TAB_WARMUP_MS);
  return true;
}

async function parkFlowTabOnLabsConnect(tabId) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (isOnLabsConnectPage(current?.url)) {
    await waitForComplete(tabId);
    return false;
  }
  await chrome.tabs.update(tabId, { url: LABS_CONNECT_URL });
  await waitForComplete(tabId);
  await wait(1_200);
  return true;
}

async function returnFlowTabToApp(tabId) {
  await chrome.tabs.update(tabId, { url: FLOW_URL });
  try {
    await waitForComplete(tabId, 30_000);
  } catch {
    // The in-page grecaptcha wait still gets a chance on a slow load.
  }
}

async function ensureManagedFlowTab({ projectId = "", connectLabs = false } = {}) {
  const existing = await findFlowTab();
  if (existing) {
    if (connectLabs) {
      if (!(await reviveFlowTabIfNeeded(existing.id))) await waitForComplete(existing.id);
      await parkFlowTabOnLabsConnect(existing.id);
    } else {
      if (isFlowMarketingUrl(existing.url) || isOnLabsConnectPage(existing.url)) {
        await returnFlowTabToApp(existing.id);
      } else if (!(await reviveFlowTabIfNeeded(existing.id))) {
        await waitForComplete(existing.id);
      }
      await parkFlowTabOnProject(existing.id, projectId);
    }
    await closeOtherFlowTabs(existing.id);
    flowTabId = existing.id;
    return existing.id;
  }

  let creating = flowTabCreating;
  if (!creating) {
    creating = (async () => {
      await closeOtherFlowTabs();
      const tab = await chrome.tabs.create({
        url: connectLabs ? LABS_CONNECT_URL : (flowProjectUrl(projectId) || FLOW_URL),
        active: false,
      });
      if (!Number.isInteger(tab?.id)) throw new Error("เปิดแท็บ Flow ไม่สำเร็จ");
      await waitForComplete(tab.id);
      await wait(FLOW_TAB_WARMUP_MS);
      await closeOtherFlowTabs(tab.id);
      flowTabId = tab.id;
      return tab.id;
    })().finally(() => {
      flowTabCreating = null;
    });
    flowTabCreating = creating;
  }
  const tabId = await creating;
  if (connectLabs) await parkFlowTabOnLabsConnect(tabId);
  else await parkFlowTabOnProject(tabId, projectId);
  return tabId;
}

async function ensureFlowProjectTab(projectId = "") {
  const tabId = await ensureManagedFlowTab({ projectId });
  return chrome.tabs.get(tabId);
}

/** The tab used for Shopee API calls, injected in both worlds if it predates us. */
async function shopeeTab() {
  const tab = await ensureTab(SHOPEE_PATTERNS, SHOPEE_URL);
  return tab;
}

const SHOPEE_ASK = { files: SHOPEE_FILES, mainFiles: SHOPEE_MAIN_FILES };
const FLOW_ASK = { files: FLOW_FILES, mainFiles: FLOW_MAIN_FILES };

// Matches next-auth/authjs session-token cookies, with or without the __Secure-/
// __Host- prefix, and the .0/.1/… suffix NextAuth appends when the JWT is too big
// for one cookie and gets split across several — same pattern ref1 uses
// (extension/src/background.js LABS_SESSION_COOKIE). All matching cookies are
// joined into one Cookie header string; the server reassembles the chunks itself.
const LABS_SESSION_COOKIE = /^(?:(?:__Secure-|__Host-)?(?:next-auth|authjs)\.session-token)(?:\.\d+)?$/;

async function harvestLabsCookieHeader() {
  const rows = await chrome.cookies.getAll({ domain: "labs.google" });
  const matches = rows.filter((c) => LABS_SESSION_COOKIE.test(c.name) && c.value);
  return matches.map((c) => `${c.name}=${c.value}`).join("; ");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs INSIDE the Flow tab via chrome.scripting.executeScript({world:"MAIN"}) —
// no closure over anything in this file, only its own params and the page's own
// `grecaptcha` (which only exists in that page context, not here in the service
// worker). Ported from ref1's mintRecaptchaInPage (extension/src/background.js,
// C:\Users\Blue\Documents\Blue Viral Beta) verbatim.
async function mintRecaptchaInPage(siteKey, captchaAction) {
  try {
    const deadline = Date.now() + 20_000;
    while ((typeof grecaptcha === "undefined" || !grecaptcha.enterprise) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (typeof grecaptcha === "undefined" || !grecaptcha.enterprise) {
      return { token: null, error: `grecaptcha.enterprise not ready at ${location.href}` };
    }
    let key = siteKey;
    if (!key) {
      try {
        if (typeof ___grecaptcha_cfg !== "undefined" && ___grecaptcha_cfg.clients) {
          for (const client of Object.values(___grecaptcha_cfg.clients)) {
            for (const value of Object.values(client)) {
              if (!value || typeof value !== "object") continue;
              for (const nested of Object.values(value)) {
                if (nested && typeof nested === "object" && nested.sitekey) {
                  key = nested.sitekey;
                  break;
                }
              }
              if (key) break;
            }
            if (key) break;
          }
        }
      } catch {
        // Fall through to the explicit no-site-key error.
      }
    }
    if (!key) return { token: null, error: "no siteKey" };
    await new Promise((resolve) => grecaptcha.enterprise.ready(resolve));
    const token = await Promise.race([
      grecaptcha.enterprise.execute(key, { action: captchaAction }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("reCAPTCHA execute timed out")), 15_000)),
    ]);
    return { token, error: null };
  } catch (error) {
    return { token: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// Runs inside flow.google.com's MAIN world. This is the fZytfe request emitted by
// Flow's own Extended button; page WIZ tokens make it unsuitable for Node fetch.
async function submitFlowExtendInPage(input) {
  const page = (typeof window !== "undefined" && window.WIZ_global_data) || {};
  const at = String(page.SNlM0e || "");
  const sid = String(page.FdrFJe || "");
  const bl = String(page.cfb2h || "");
  if (!at || !bl) return { ok: false, error: `page tokens missing at=${Boolean(at)} bl=${Boolean(bl)} url=${location.href}` };

  const projectId = String(input?.projectId || "").trim();
  const sourceMediaId = String(input?.sourceMediaId || "").trim();
  const sceneId = String(input?.sceneId || "").trim();
  const prompt = String(input?.prompt || "").trim();
  const captchaToken = String(input?.captchaToken || "").trim();
  const videoModel = String(input?.videoModel || "").trim();
  const position = Math.max(1, Math.min(2, Number(input?.position) || 1));
  if (!projectId || !sourceMediaId || !sceneId || !prompt || !captchaToken || !videoModel) {
    return { ok: false, error: "Extended request fields are incomplete" };
  }
  if (!/^[A-Za-z0-9_.:-]{2,100}$/.test(videoModel)) return { ok: false, error: "invalid videoModel" };
  const width = input?.aspect === "landscape" ? 192 : 169;
  const height = input?.aspect === "landscape" ? 108 : 192;
  const uuid = () => crypto.randomUUID().toUpperCase();
  const request = [
    [[
      [null, sourceMediaId, width, height],
      [null, null, [[[prompt]]]],
      videoModel,
      1,
      null,
      [sceneId, null, null, null, uuid(), uuid()],
    ]],
    [null, 22, null, null, null, projectId, null, null, null, null, [captchaToken, 1]],
    [uuid(), 1, null, [sceneId, position]],
  ];
  const freq = JSON.stringify([[["fZytfe", JSON.stringify(request), null, "generic"]]]);
  const params = new URLSearchParams({
    rpcids: "fZytfe",
    "source-path": `/project/${encodeURIComponent(projectId)}/scene/${encodeURIComponent(sceneId)}`,
    bl,
    hl: document.documentElement.lang || "en",
    _reqid: String(Math.floor(Math.random() * 900000) + 100000),
    rt: "c",
  });
  if (sid) params.set("f.sid", sid);

  let text = "";
  try {
    const response = await fetch(`/_/AiSandboxAngularFrontend/data/batchexecute?${params}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(at)}&`,
    });
    text = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, body: text.slice(0, 300) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }

  try {
    let payload;
    const visit = (value) => {
      if (payload !== undefined || !Array.isArray(value)) return;
      if (value[0] === "wrb.fr" && value[1] === "fZytfe") {
        payload = typeof value[2] === "string" ? JSON.parse(value[2]) : value[2];
        return;
      }
      for (const child of value) visit(child);
    };
    for (const rawLine of String(text).replace(/^\)\]\}'\s*/, "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("[")) continue;
      try { visit(JSON.parse(line)); } catch { /* length-prefix or partial frame */ }
      if (payload !== undefined) break;
    }
    if (payload === undefined) return { ok: false, error: "fZytfe response frame missing", body: text.slice(0, 300) };
    const responseRecord = payload?.[3]?.[0];
    const record = Array.isArray(responseRecord?.[0]) ? responseRecord[0] : responseRecord;
    const mediaId = Array.isArray(record) ? String(record[0] || "") : "";
    const payloadText = JSON.stringify(payload);
    if (!mediaId && /PUBLIC_ERROR_USER_QUOTA_REACHED|USER_QUOTA_REACHED/i.test(payloadText)) {
      if (videoModel === "veo_3_1_r2v_lite_low_priority") {
        return { ok: false, error: "FLOW_FREE_MODEL_CREDIT_WARNING: retry free model without pausing queue" };
      }
      return { ok: false, error: "FLOW_USER_QUOTA_REACHED: Google Flow quota exhausted" };
    }
    if (!mediaId) return { ok: false, error: "no mediaId in fZytfe response", body: text.slice(0, 300) };
    return {
      ok: true,
      mediaId,
      mediaName: mediaId,
      pendingMediaName: mediaId,
      projectId: String(record[1] || projectId),
      workflowId: String(record[2] || ""),
      sceneId: String(record[record.length - 1] || sceneId),
      model: videoModel,
    };
  } catch (error) {
    return { ok: false, error: `parse failed: ${error?.message || error}`, body: text.slice(0, 300) };
  }
}

// ------------------------------------------------------------------ dispatch
async function dispatch(command) {
  const { action, data } = command;

  switch (action) {
    case ACTION.PING:
      return { pong: true, version: VERSION };

    case ACTION.STATUS:
      return { sites: await siteStatus() };

    case ACTION.SHOPEE_SEARCH: {
      const tab = await shopeeTab();
      return askTab(tab.id, { bsp: "shopee.search", data }, SHOPEE_ASK);
    }

    case ACTION.SHOPEE_PRODUCT: {
      // Resolving a short link is a navigation, not an API call: open it in a
      // background tab, read where it landed, then close it.
      if (data.resolveUrl) return resolveShortLink(data.resolveUrl);
      const tab = await shopeeTab();
      return askTab(tab.id, { bsp: "shopee.product", data }, SHOPEE_ASK);
    }

    case ACTION.SHOPEE_OFFER: {
      const tab = await shopeeTab();
      return askTab(tab.id, { bsp: "shopee.offer", data }, SHOPEE_ASK);
    }

    case ACTION.FLOW_ENSURE_TAB: {
      // Opened in the BACKGROUND (ensureTab defaults active:false) — a real,
      // signed-in Flow tab scores a clean reCAPTCHA regardless of whether the
      // operator is looking at it, and there is no more UI to click, so it never
      // needs to be brought forward. ref2's own comment on this: pulling the
      // operator to labs.google tempts a fresh sign-in, which rotates the session
      // token and breaks the saved cookie.
      const tab = await ensureFlowProjectTab(data?.projectId);
      const probe = await askTab(tab.id, { bsp: "flow.probe", data: {} }, FLOW_ASK);
      return { ok: true, tabId: tab.id, ...probe };
    }

    // The labs.google session lives in an HttpOnly NextAuth cookie — page JS
    // (even flow-api.js's MAIN-world script) cannot read it; only the extension's
    // chrome.cookies API can. The bridge uses this as the Cookie header for its
    // OWN direct calls to labs.google (session/project/media-redirect) — see
    // server/flow-client.mjs.
    case ACTION.FLOW_HARVEST_COOKIES: {
      // Ensure a Flow tab exists BEFORE reading cookies — a bridge that's never had
      // a labs.google tab open (or one that got closed) had nothing for
      // chrome.cookies.getAll to find, so this used to throw immediately (or the
      // caller's own timeout would fire first) instead of ever trying to establish
      // one. Matches ref1's actual model for this exact command (extension/src/
      // background.js's captureFlowSession(), C:\Users\Blue\Documents\Blue Viral
      // Beta): open/reuse the tab first, then poll for the cookie a few times — a
      // freshly-opened tab's session cookie takes a beat to actually get set — and
      // only give up (bringing the tab forward so the operator notices) after that.
      const tabId = await ensureManagedFlowTab({ connectLabs: true });
      const tab = await chrome.tabs.get(tabId);
      let cookieHeader = "";
      for (let attempt = 0; attempt < 8 && !cookieHeader; attempt += 1) {
        cookieHeader = await harvestLabsCookieHeader();
        if (!cookieHeader) await wait(attempt === 0 ? 400 : 900);
      }
      if (!cookieHeader) {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          const fresh = await chrome.tabs.get(tab.id);
          if (Number.isInteger(fresh.windowId)) await chrome.windows.update(fresh.windowId, { focused: true });
        } catch { /* best effort — the error below still tells the operator what to do */ }
        throw new Error("ไม่พบ session cookie ของ labs.google — ล็อกอิน Flow ในแท็บที่เปิดให้แล้ว");
      }
      return { cookieHeader };
    }

    case ACTION.FLOW_MINT_CAPTCHA: {
      // Used to relay through flow.js (ISOLATED) -> window.postMessage ->
      // flow-api.js (MAIN) -> grecaptcha.enterprise.execute() -> postMessage back
      // -> flow.js -> chrome.runtime response -> here. Four hops, two of them
      // content-script listeners that can be stale/not-yet-registered after a tab
      // reload or a slow page load, each with its own 20s/15s timeout layered on
      // top of the bridge's own 30s ext.command timeout — any one weak link in
      // that chain silently hangs the whole thing until something times out
      // ("คำสั่ง flow.mintCaptcha หมดเวลา (30s)", repeatedly, even with a Flow tab
      // open and mintCaptcha's actual logic being nearly instant).
      //
      // ref1's actual model for this (extension/src/background.js's
      // mintCharacterCaptcha, C:\Users\Blue\Documents\Blue Viral Beta) skips all of
      // that: chrome.scripting.executeScript with world:"MAIN" runs the mint
      // function directly IN the tab from the service worker and hands the return
      // value straight back through executeScript's own promise — one hop, no
      // content-script relay, no separate listener to go stale. Ported verbatim
      // below, including its 2-attempt/2s-apart retry.
      const tab = await ensureFlowProjectTab(data?.projectId);
      const captchaAction = typeof data?.action === "string" && data.action ? data.action : "VIDEO_GENERATION";
      let lastError = "reCAPTCHA Enterprise is not ready";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: mintRecaptchaInPage,
            args: [RECAPTCHA_SITE_KEY, captchaAction],
          });
          const result = results?.[0]?.result;
          if (typeof result?.token === "string" && result.token) return { token: result.token };
          lastError = result?.error || lastError;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt === 0) await wait(2_000);
      }
      throw new Error(lastError);
    }

    case ACTION.FLOW_REFRESH_CAPTCHA: {
      const projectUrl = flowProjectUrl(data?.projectId);
      if (!projectUrl) throw new Error("ต้องมี projectId ที่ถูกต้องเพื่อ refresh reCAPTCHA");
      if (!flowTabRefreshing) {
        flowTabRefreshing = (async () => {
          const tab = await ensureFlowProjectTab(data.projectId);
          await chrome.tabs.update(tab.id, { url: `${FLOW_URL}?reload=${Date.now()}` });
          await waitForComplete(tab.id);
          await chrome.tabs.update(tab.id, { url: projectUrl });
          await waitForComplete(tab.id);
          await wait(FLOW_TAB_WARMUP_MS);
          flowTabId = tab.id;
          return tab.id;
        })().finally(() => {
          flowTabRefreshing = null;
        });
      }
      const tabId = await flowTabRefreshing;
      return { ok: true, tabId };
    }

    case ACTION.FLOW_EXTEND_SUBMIT: {
      const projectId = String(data?.projectId || "").trim();
      if (!flowProjectUrl(projectId)) throw new Error("ต้องมี projectId ที่ถูกต้องสำหรับ Extended");
      const tab = await ensureFlowProjectTab(projectId);
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: submitFlowExtendInPage,
        args: [{
          projectId,
          sourceMediaId: data?.sourceMediaId,
          sceneId: data?.sceneId,
          prompt: data?.prompt,
          captchaToken: data?.captchaToken,
          videoModel: data?.videoModel,
          position: data?.position,
          aspect: data?.aspect,
        }],
      });
      const result = out?.[0]?.result;
      if (!result?.ok || !result.mediaId) {
        const detail = String(result?.body || "").replace(/\s+/g, " ").slice(0, 240);
        throw new Error(`${result?.error || "Flow Extended submit failed"}${detail ? ` — ${detail}` : ""}`);
      }
      return result;
    }

    default:
      throw new Error(`ไม่รู้จักคำสั่ง ${action}`);
  }
}

async function resolveShortLink(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForComplete(tab.id, 30_000);
    const fresh = await chrome.tabs.get(tab.id);
    return { url: fresh.url || url };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ------------------------------------------------------------------ poll loop
async function loop() {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      const port = await ensureConnected();
      if (!port) { await sleep(5000); continue; }

      let command;
      try {
        command = await bridge.pollCommand();
      } catch {
        // Bridge restarted or moved ports — rediscover on the next pass.
        await sleep(2000);
        continue;
      }
      if (!command) continue;   // poll window expired; immediately re-poll

      try {
        const result = await dispatch(command);
        await bridge.sendResult(command.id, result);
      } catch (err) {
        await bridge.sendError(command.id, err);
      }
    }
  } finally {
    looping = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ lifecycle
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("bluespite-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
  loop();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("bluespite-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
  loop();
});
chrome.alarms.onAlarm.addListener(() => { loop(); });

// Report tab availability whenever the operator opens/closes a provider tab, so the
// web UI's status chips stay honest without polling.
const reportStatus = debounce(async () => {
  if (!bridge.baseUrl()) return;
  await bridge.sendStatus(await siteStatus());
}, 1200);
chrome.tabs.onUpdated.addListener(reportStatus);
chrome.tabs.onRemoved.addListener(reportStatus);

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// The popup asks for a live snapshot and can force a reconnect.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.bsp === "popup.state") {
    (async () => {
      const { bridgePort, connected } = await chrome.storage.local.get(["bridgePort", "connected"]);
      respond({ version: VERSION, bridgePort, connected, sites: await siteStatus() });
    })();
    return true;
  }
  if (msg?.bsp === "popup.reconnect") {
    ensureConnected().then((port) => respond({ port })).catch((e) => respond({ error: e.message }));
    return true;
  }
  return false;
});

loop();
