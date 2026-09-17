// BlueSPite web UI. Reads one live snapshot over SSE and re-renders from it — there is
// no client-side copy of the truth beyond the operator's in-progress form picks.
//
// The catalog and the prompt builder are imported from /shared/, the same modules the
// bridge runs, so the prompt preview on screen is literally what gets submitted.

import {
  DIRECTION_FIELDS, STYLE_OPTIONS, FLOW_IMAGE_MODELS, ASPECTS_VIDEO,
  DEFAULT_VIDEO_MODEL, DEFAULT_IMAGE_MODEL, videoModel, videoModelsForTier,
  CUSTOM_PREFIX, MAX_CUSTOM_DIRECTION_LEN, customValueText,
  TEXT_MODES, DEFAULT_TEXT_MODE, MAX_CONCURRENCY, DEFAULT_CONCURRENCY, CONCURRENT_SAFE_MODELS,
} from "/shared/catalog.mjs";
import { buildPrompt, buildTripleBotExtendedPrompt } from "/shared/prompt.mjs";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of [].concat(kids)) if (kid) node.append(kid);
  return node;
};

// ───────────────────────────────────────────────────────── local UI state
const ui = {
  page: "search",
  snapshot: null,
  searchItems: [],          // last search results (kept client-side; the bridge also stores them)
  searchSelected: new Set(),
  direction: {},            // field -> value ("" | id | "custom:text") — mirrors settings.direction
  sceneVideoPrompts: Array.from({ length: 10 }, () => ""),
  samplePicks: [],          // products currently shown in the Setting-Prompt preview box
  settingsLoaded: false,    // guards persistSettings() from firing while the form is still being populated
  busy: false,
};

// ───────────────────────────────────────────────────────── plumbing
function toast(msg, isError = false) {
  const node = $("toast");
  node.textContent = msg;
  node.className = `toast${isError ? " err" : ""}`;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, isError ? 7000 : 3200);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function withBusy(button, label, fn) {
  return async (...args) => {
    if (ui.busy) return;
    ui.busy = true;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, true);
    } finally {
      ui.busy = false;
      button.disabled = false;
      button.textContent = original;
    }
  };
}

const baht = (n) => Number(n || 0).toLocaleString("th-TH", { maximumFractionDigits: 0 });
const compact = (n) => Number(n || 0).toLocaleString("th-TH", { notation: "compact", maximumFractionDigits: 1 });

// mm:ss (or h:mm:ss past an hour) — shared by the queue page's live timer and the
// History page's start-to-finish duration.
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// ───────────────────────────────────────────────────────── navigation
for (const btn of $("nav").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    ui.page = btn.dataset.page;
    for (const b of $("nav").querySelectorAll("button")) b.classList.toggle("on", b === btn);
    for (const p of document.querySelectorAll(".page")) p.classList.toggle("on", p.dataset.page === ui.page);
    // Land on Setting Prompt with something to look at right away.
    if (ui.page === "generate" && !ui.samplePicks.length && ui.snapshot?.products?.length) sampleProducts(1);
  });
}

function goto(page) {
  $("nav").querySelector(`button[data-page="${page}"]`)?.click();
}

// ───────────────────────────────────────────────────────── live state
function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("state", (event) => {
    ui.snapshot = JSON.parse(event.data);
    renderLink();
    renderProducts();
    renderJobs();
    renderHistory();
    renderLog();
    syncModelSelect();
  });
  source.addEventListener("error", () => {
    $("extLabel").textContent = "ขาดการเชื่อมต่อกับ bridge";
    $("extDot").className = "dot off";
  });
}

function renderLink() {
  const ext = ui.snapshot?.ext || {};
  $("extDot").className = `dot ${ext.online ? "on" : "off"}`;
  $("extLabel").textContent = ext.online
    ? `Extension v${ext.version || "?"} เชื่อมต่อแล้ว`
    : "ยังไม่เชื่อมต่อ extension";

  for (const [key, dot, info] of [["shopee", "shopeeDot", "shopeeInfo"], ["flow", "flowDot", "flowInfo"]]) {
    const site = ext.sites?.[key] || {};
    $(dot).className = `dot small ${site.ok ? "on" : "off"}`;
    $(info).textContent = site.detail || "—";
  }
}

// ───────────────────────────────────────────────────────── 1. search page
// icon + short "what raising this does" hint, so the sliders read as 4 knobs for
// "push X to the top" rather than bare numbers with no context (operator
// feedback: the plain 0-3 sliders alone were confusing).
const RANK_INFO = {
  sales: { icon: "📈", label: "ยอดขาย", hint: "ดันสินค้าที่ขายดีขึ้นก่อน" },
  rating: { icon: "⭐", label: "เรตติ้ง", hint: "ดันสินค้ารีวิวดีขึ้นก่อน" },
  price: { icon: "💸", label: "ราคาถูก", hint: "ดันสินค้าราคาถูกขึ้นก่อน" },
  commission: { icon: "💰", label: "ค่าคอมฯ", hint: "ดันสินค้าที่ให้ค่าคอมฯ สูงขึ้นก่อน" },
};

// Same 0-3/step-0.5 scale as before (unchanged server-side meaning) — just shown
// in words instead of a bare number, since "1.5" alone doesn't say whether that's
// a lot or a little.
function rankWeightWord(value) {
  if (value <= 0) return "ปิด";
  if (value <= 1) return "น้อย";
  if (value <= 2) return "ปานกลาง";
  return "มาก";
}

function renderWeights() {
  const grid = $("weightGrid");
  grid.replaceChildren();
  const current = ui.snapshot?.settings?.rank || { sales: 1, rating: 1, price: 1, commission: 1 };
  for (const [key, { icon, label, hint }] of Object.entries(RANK_INFO)) {
    const value = Number(current[key] ?? 1);
    const input = el("input", { type: "range", min: "0", max: "3", step: "0.5", value: String(value) });
    const readout = el("b", { textContent: rankWeightWord(value) });
    const card = el("div", { className: "weight-card" });
    const syncOff = (v) => card.classList.toggle("off", Number(v) <= 0);
    syncOff(value);
    input.addEventListener("input", () => { readout.textContent = rankWeightWord(Number(input.value)); syncOff(input.value); });
    input.addEventListener("change", async () => {
      await api("/api/settings", { method: "POST", body: { rank: { [key]: Number(input.value) } } });
      if (ui.searchItems.length) toast("บันทึกน้ำหนักแล้ว — ค้นหาอีกครั้งเพื่อจัดอันดับใหม่");
    });
    card.append(
      el("div", { className: "weight-head" }, [
        el("span", { className: "weight-icon", textContent: icon }),
        el("span", { className: "weight-label", textContent: label }),
        readout,
      ]),
      el("p", { className: "weight-hint", textContent: hint }),
      input,
      el("div", { className: "weight-scale" }, [
        el("span", { textContent: "ไม่นับ" }),
        el("span", { textContent: "มากที่สุด" }),
      ]),
    );
    grid.append(card);
  }
}

$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});

const runSearch = withBusy($("searchBtn"), "กำลังค้นหา…", async () => {
  const out = await api("/api/search", {
    method: "POST",
    body: {
      keyword: $("keyword").value.trim(),
      limit: Number($("limit").value),
      minPrice: Number($("minPrice").value) || 0,
      maxPrice: Number($("maxPrice").value) || 0,
      withCommission: $("withCommission").checked,
    },
  });
  ui.searchItems = out.items;
  ui.searchSelected.clear();
  renderSearch();
  if (!out.items.length) toast("ไม่พบสินค้าตามคำค้นนี้");
});

function renderSearch() {
  const list = $("searchResults");
  list.replaceChildren();
  $("searchToolbar").hidden = !ui.searchItems.length;

  if (!ui.searchItems.length) {
    list.append(el("div", { className: "empty", textContent: "ยังไม่มีผลค้นหา — ใส่คำค้นแล้วกดค้นหา" }));
    return;
  }
  $("searchCount").textContent = `${ui.searchItems.length} รายการ · เรียงตามคะแนน`;

  for (const item of ui.searchItems) {
    const check = el("input", { type: "checkbox", checked: ui.searchSelected.has(item.id) });
    check.addEventListener("change", () => {
      if (check.checked) ui.searchSelected.add(item.id);
      else ui.searchSelected.delete(item.id);
      updateSearchToolbar();
    });

    const meta = el("div", { className: "meta" }, [
      el("span", {}, [el("b", { textContent: `฿${baht(item.price)}` })]),
      item.discount ? el("span", { className: "tag", textContent: `-${item.discount}%` }) : null,
      el("span", {}, [`ขายแล้ว `, el("b", { textContent: compact(item.sold) })]),
      el("span", {}, [`⭐ `, el("b", { textContent: item.rating ? item.rating.toFixed(1) : "—" }), ` (${compact(item.ratingCount)})`]),
      item.commissionRate ? el("span", {}, [`คอมฯ `, el("b", { textContent: `${item.commissionRate}%` })]) : null,
      item.isOfficialShop ? el("span", { className: "tag", textContent: "Mall" }) : null,
      el("span", { textContent: item.shopName || "" }),
    ]);

    list.append(el("div", { className: "item" }, [
      check,
      el("img", { src: item.image, alt: "", loading: "lazy" }),
      el("div", {}, [
        el("h3", {}, [el("a", { href: item.url, target: "_blank", rel: "noreferrer", textContent: item.name })]),
        meta,
      ]),
      scoreBlock(item),
    ]));
  }
  updateSearchToolbar();
}

function scoreBlock(item) {
  const bars = el("div", { className: "bars" });
  for (const [key, { label }] of Object.entries(RANK_INFO)) {
    const pct = Math.round((item.signals?.[key] || 0) * 100);
    bars.append(el("div", { className: "bar" }, [
      el("span", { textContent: label }),
      el("i", {}, [el("b", { style: `width:${pct}%` })]),
    ]));
  }
  return el("div", { className: "score" }, [
    el("div", { className: "score-num", textContent: (item.score ?? 0).toFixed(2) }),
    bars,
  ]);
}

function updateSearchToolbar() {
  const n = ui.searchSelected.size;
  $("sendToScan").disabled = n === 0;
  $("sendToQueue").disabled = n === 0;
  $("copyLinks").disabled = n === 0;
  $("sendToScan").textContent = n ? `ส่ง ${n} ลิงก์ไปสแกน` : "ส่งลิงก์ที่เลือกไปสแกน";
  $("sendToQueue").textContent = n ? `🎬 ส่ง ${n} รายการไปคิว` : "🎬 ส่งไปคิว";
}

$("selectAllSearch").addEventListener("click", () => {
  const all = ui.searchSelected.size === ui.searchItems.length;
  ui.searchSelected = all ? new Set() : new Set(ui.searchItems.map((i) => i.id));
  renderSearch();
});

function selectedLinks() {
  return ui.searchItems.filter((i) => ui.searchSelected.has(i.id)).map((i) => i.url);
}

$("copyLinks").addEventListener("click", async () => {
  const text = selectedLinks().join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast(`คัดลอก ${ui.searchSelected.size} ลิงก์แล้ว`);
  } catch {
    // Clipboard can be blocked; drop the links into the scan box instead of failing.
    $("scanText").value = text;
    goto("scan");
    toast("คัดลอกไม่ได้ — ใส่ลิงก์ไว้ในหน้าสแกนให้แล้ว");
  }
});

$("sendToScan").addEventListener("click", () => {
  $("scanText").value = selectedLinks().join("\n");
  goto("scan");
  toast(`ใส่ ${ui.searchSelected.size} ลิงก์ในหน้าสแกนแล้ว — กดสแกนเพื่อดึงรายละเอียด`);
});

// One click from search results straight into the queue: scan the selected links
// ONE AT A TIME (need each full PDP — images, description — before a job can be
// built), showing "N/total" progress on the button the same way sendAllBtn does,
// then queue every scanned product with whatever's set on the Setting Prompt page.
$("sendToQueue").addEventListener("click", async () => {
  if (ui.busy) return;
  const links = selectedLinks();
  if (!links.length) return;

  ui.busy = true;
  const btn = $("sendToQueue");
  const original = btn.textContent;
  btn.disabled = true;

  const saved = [];
  const failed = [];
  for (const link of links) {
    btn.textContent = `กำลังสแกน ${saved.length + failed.length + 1}/${links.length}…`;
    try {
      const out = await api("/api/scan", { method: "POST", body: { links: [link] } });
      saved.push(...out.saved);
      failed.push(...out.failed);
    } catch (err) {
      failed.push({ link, reason: err.message });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (saved.length) {
    btn.textContent = `กำลังส่งเข้าคิว…`;
    try {
      await api("/api/jobs", {
        method: "POST",
        body: { productIds: saved.map((p) => p.id), ...currentJobParams() },
      });
      await maybeAutoRunQueue();
    } catch (err) {
      toast(err.message, true);
    }
  }

  btn.disabled = false;
  btn.textContent = original;
  ui.busy = false;

  if (!saved.length) {
    toast(`สแกนไม่สำเร็จทั้ง ${failed.length} ลิงก์: ${failed[0]?.reason || ""}`, true);
    return;
  }
  ui.searchSelected.clear();
  goto("queue");
  toast(failed.length
    ? `ส่งเข้าคิวแล้ว (${saved.length}/${links.length}) — สแกนไม่สำเร็จ ${failed.length} รายการ`
    : `ส่งเข้าคิวแล้ว (${saved.length}/${links.length})`,
  Boolean(failed.length));
});

// ───────────────────────────────────────────────────────── 2. scan page
$("scanForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runScan();
});

const runScan = withBusy($("scanBtn"), "กำลังสแกน…", async () => {
  const text = $("scanText").value.trim();
  if (!text) throw new Error("วางลิงก์สินค้าก่อน");
  $("scanStatus").textContent = "ส่งคำสั่งไปที่ extension…";
  const out = await api("/api/scan", { method: "POST", body: { text } });
  $("scanStatus").textContent = `สำเร็จ ${out.saved.length} · ไม่สำเร็จ ${out.failed.length}`;
  if (out.failed.length) {
    toast(`ไม่สำเร็จ ${out.failed.length} ลิงก์: ${out.failed[0].reason}`, true);
  } else {
    toast(`สแกนสำเร็จ ${out.saved.length} สินค้า`);
    $("scanText").value = "";
  }
});

function renderProducts() {
  const list = $("productList");
  const products = ui.snapshot?.products || [];
  list.replaceChildren();
  $("productCount").textContent = `${products.length} สินค้าที่สแกนแล้ว`;
  $("clearProducts").disabled = !products.length;
  $("sendAllBtn").disabled = !products.length;

  if (!products.length) {
    list.append(el("div", { className: "empty", textContent: "ยังไม่มีสินค้า — วางลิงก์แล้วกดสแกน" }));
    return;
  }

  const jobs = ui.snapshot?.jobs || [];   // newest-first — first match per product is the latest order
  for (const p of products) {
    const del = el("button", { className: "ghost danger", textContent: "ลบ" });
    del.addEventListener("click", async () => {
      await api("/api/products", { method: "DELETE", body: { id: p.id } });
    });
    // Queues this ONE product immediately using whatever is set on the Setting
    // Prompt page — there is no per-product picker/override anymore.
    const use = el("button", { className: "primary", textContent: "สร้างวิดีโอ" });
    use.addEventListener("click", withBusy(use, "กำลังเพิ่ม…", async () => {
      await api("/api/jobs", { method: "POST", body: { productIds: [p.id], ...currentJobParams() } });
      await maybeAutoRunQueue();
      // Stay on this page — just confirm it landed in the queue, no navigation.
      toast(`ส่งเข้าคิวแล้ว (1/1)`);
    }));

    const lastJob = jobs.find((j) => j.productId === p.id);

    list.append(el("div", { className: "item no-check" }, [
      el("img", { src: p.images?.[0] || p.image || "", alt: "", loading: "lazy" }),
      el("div", {}, [
        el("h3", {}, [el("a", { href: p.url, target: "_blank", rel: "noreferrer", textContent: p.name })]),
        el("div", { className: "meta" }, [
          el("span", {}, [el("b", { textContent: `฿${baht(p.price)}` })]),
          el("span", {}, [`ขายแล้ว `, el("b", { textContent: compact(p.sold) })]),
          el("span", {}, [`รูป `, el("b", { textContent: String(p.images?.length || 0) })]),
          p.brand ? el("span", { textContent: p.brand }) : null,
          p.sellingPoints?.length ? el("span", { textContent: `จุดขาย ${p.sellingPoints.length} ข้อ` }) : null,
        ]),
        lastJob?.orderNumber ? el("div", { className: "meta" }, [
          el("span", { className: "tag order-tag", textContent: lastJob.orderNumber }),
          el("span", { textContent: STATUS_LABEL[lastJob.status] || lastJob.status }),
        ]) : null,
      ]),
      el("div", { className: "row" }, [use, del]),
    ]));
  }
}

$("clearProducts").addEventListener("click", async () => {
  if (!confirm("ลบสินค้าที่สแกนไว้ทั้งหมด?")) return;
  await api("/api/products", { method: "DELETE", body: { all: true } });
  toast("ล้างสินค้าแล้ว");
});

$("gotoSettingsBtn").addEventListener("click", () => goto("generate"));

// Queues every scanned product using the current Setting-Prompt config. Sent ONE
// product at a time (not a single batched call) so the operator sees live progress
// and so 50+ simultaneous job-creates never pile up as one long write on the bridge
// — a short stagger between calls keeps the SSE broadcast + debounced store write
// from bunching into one big stall.
$("sendAllBtn").addEventListener("click", async () => {
  if (ui.busy) return;
  const products = ui.snapshot?.products || [];
  if (!products.length) return toast("ยังไม่มีสินค้า — ไปสแกนก่อน", true);
  if (!confirm(`ส่งสินค้าทั้งหมด ${products.length} รายการเข้าคิวสร้างวิดีโอ ด้วยค่าที่ตั้งไว้ในหน้า "ตั้งค่า Prompt"?`)) return;

  ui.busy = true;
  const btn = $("sendAllBtn");
  const original = btn.textContent;
  btn.disabled = true;
  $("gotoSettingsBtn").disabled = true;

  const params = currentJobParams();
  let done = 0;
  let failed = 0;
  for (const p of products) {
    btn.textContent = `กำลังส่ง ${done + failed + 1}/${products.length}…`;
    try {
      await api("/api/jobs", { method: "POST", body: { productIds: [p.id], ...params } });
      done += 1;
    } catch {
      failed += 1;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (done) await maybeAutoRunQueue();

  btn.disabled = false;
  btn.textContent = original;
  $("gotoSettingsBtn").disabled = false;
  ui.busy = false;
  // (จำนวนที่ส่งสำเร็จ/จำนวนทั้งหมดที่กดส่งไป) — stay on this page, no navigation.
  toast(
    failed
      ? `ส่งเข้าคิวแล้ว (${done}/${products.length}) — ล้มเหลว ${failed} รายการ`
      : `ส่งเข้าคิวแล้ว (${done}/${products.length})`,
    Boolean(failed),
  );
});

// ───────────────────────────────────────────────────────── 3. Setting Prompt page
// This page no longer picks a product — it edits the GLOBAL generate settings
// (persisted on the bridge via /api/settings) that every "สร้างวิดีโอ" /
// "ส่งสร้างวิดีโอทั้งหมด" click on the scan page reads at queue-time. Every field
// here auto-saves (debounced) and, if the sample preview is showing, re-renders it
// live so a dropdown change is visible immediately without re-rolling.

function renderDirection() {
  const grid = $("directionGrid");
  grid.replaceChildren();

  for (const [field, label] of DIRECTION_FIELDS) {
    const select = el("select", { id: `dir-${field}` });
    select.append(el("option", { value: "", textContent: "AI เลือกให้" }));
    for (const [id, name] of STYLE_OPTIONS[field] || []) {
      select.append(el("option", { value: id, textContent: name }));
    }
    select.append(el("option", { value: "__custom__", textContent: "✎ กำหนดเอง…" }));

    const custom = el("input", {
      type: "text", placeholder: "พิมพ์เอง…", maxLength: MAX_CUSTOM_DIRECTION_LEN, hidden: true,
    });

    select.addEventListener("change", () => {
      custom.hidden = select.value !== "__custom__";
      if (select.value === "__custom__") {
        ui.direction[field] = custom.value.trim() ? CUSTOM_PREFIX + custom.value.trim() : "";
        custom.focus();
      } else {
        ui.direction[field] = select.value;
      }
      persistSettings();
      refreshSampleBox();
    });
    custom.addEventListener("input", () => {
      ui.direction[field] = custom.value.trim() ? CUSTOM_PREFIX + custom.value.trim() : "";
      persistSettings();
      refreshSampleBox();
    });

    grid.append(el("div", { className: "field" }, [
      el("label", { htmlFor: select.id, textContent: label }),
      select,
      custom,
    ]));
  }
}

function renderModelSelects() {
  const imageSelect = $("imageModel");
  imageSelect.replaceChildren();
  for (const m of FLOW_IMAGE_MODELS) {
    imageSelect.append(el("option", { value: m.id, textContent: m.label }));
  }
  imageSelect.value = DEFAULT_IMAGE_MODEL;

  const aspectSelect = $("aspect");
  aspectSelect.replaceChildren();
  for (const a of ASPECTS_VIDEO) aspectSelect.append(el("option", { value: a.id, textContent: a.label }));

  const textModeSelect = $("textMode");
  textModeSelect.replaceChildren();
  for (const t of TEXT_MODES) textModeSelect.append(el("option", { value: t.id, textContent: t.label }));
  textModeSelect.value = DEFAULT_TEXT_MODE;

  $("videoModel").addEventListener("change", () => { syncModelNote(); persistSettings(); refreshSampleBox(); });
  for (const id of ["imageModel", "aspect", "textMode", "characterMode"]) {
    $(id).addEventListener("change", () => { syncModelNote(); persistSettings(); refreshSampleBox(); });
  }
  $("sceneMode").addEventListener("change", () => {
    applySceneModeRestriction();
    renderScenePromptInputs();
    persistSettings();
    refreshSampleBox();
  });
  $("sceneCount").addEventListener("input", debounce(() => {
    applySceneModeRestriction();
    renderScenePromptInputs();
    persistSettings();
    refreshSampleBox();
  }, 350));
  $("concurrency").addEventListener("input", debounce(() => { syncModelNote(); persistSettings(); }, 350));
  $("extraPrompt").addEventListener("input", debounce(() => { persistSettings(); refreshSampleBox(); }, 350));
}

// Current form values, in the shape /api/settings expects. Shared by the debounced
// auto-save and the explicit "บันทึกการตั้งค่า" button below.
function settingsPayload() {
  return {
    defaultVideoModel: $("videoModel").value,
    defaultImageModel: $("imageModel").value,
    aspect: $("aspect").value,
    characterMode: $("characterMode").value === "consistent" ? "consistent" : "random",
    sceneMode: $("sceneMode").value === "continuous" ? "continuous" : "independent",
    sceneCount: Math.max(1, Number($("sceneCount").value) || 1),
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number($("concurrency").value) || 1)),
    textMode: $("textMode").value,
    direction: ui.direction,
    extraPrompt: $("extraPrompt").value,
    sceneVideoPrompts: ui.sceneVideoPrompts.slice(0, 10),
  };
}

// Auto-save on every field change. Guarded on settingsLoaded so the initial
// population of the form (from whatever was already saved) doesn't immediately
// re-save itself.
const persistSettings = debounce(() => {
  if (!ui.settingsLoaded) return;
  api("/api/settings", { method: "POST", body: settingsPayload() })
    .catch((err) => toast(err.message, true));
}, 400);

// Explicit save button — bypasses the debounce for an immediate, confirmed save.
$("saveSettingsBtn").addEventListener("click", withBusy($("saveSettingsBtn"), "กำลังบันทึก…", async () => {
  await api("/api/settings", { method: "POST", body: settingsPayload() });
  toast("บันทึกการตั้งค่าแล้ว");
}));

// What every queue-time call (per-product button, send-all) sends as job params.
// Reads the LIVE form/ui.direction state directly — the same source
// renderSampleBox()'s preview uses — instead of ui.snapshot.settings (the server's
// last-broadcast echo). That echo lags behind: field edits auto-save via a debounced
// (350ms) /api/settings call, and the updated snapshot only comes back over SSE after
// that round-trip completes. An operator who tweaks a field (e.g. โหมดข้อความ) and
// clicks "ส่งไปคิว"/"ส่งสินค้าทั้งหมด" shortly after could queue a job built from the
// PREVIOUS settings while the Setting-Prompt preview already showed the new ones —
// exactly the "Setting Prompt page is right but what actually generated isn't"
// mismatch this replaces. Key names match what /api/jobs (handleJobSubmit) expects.
function currentJobParams() {
  return {
    videoModel: $("videoModel").value,
    imageModel: $("imageModel").value,
    aspect: $("aspect").value,
    characterMode: $("characterMode").value === "consistent" ? "consistent" : "random",
    sceneMode: $("sceneMode").value === "continuous" ? "continuous" : "independent",
    sceneCount: Math.max(1, Number($("sceneCount").value) || 1),
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number($("concurrency").value) || 1)),
    textMode: $("textMode").value,
    direction: ui.direction,
    extraPrompt: $("extraPrompt").value,
    sceneVideoPrompts: ui.sceneVideoPrompts.slice(0, 10),
  };
}

// One-time form population from whatever settings the bridge already has (page load
// only — NOT on every SSE tick, or the operator's in-progress edits would be
// fought/overwritten the moment another tab or the runner touches settings).
function applySettingsToForm(settings = {}) {
  ui.direction = { ...(settings.direction || {}) };
  for (const [field] of DIRECTION_FIELDS) {
    const select = $(`dir-${field}`);
    const custom = select.nextElementSibling;
    const val = ui.direction[field] || "";
    if (val.startsWith(CUSTOM_PREFIX)) {
      select.value = "__custom__";
      custom.hidden = false;
      custom.value = customValueText(val);
    } else {
      select.value = val;
      custom.hidden = true;
      custom.value = "";
    }
  }

  syncModelSelect();   // builds the videoModel <option>s first — must run before assigning
  if (settings.defaultVideoModel) $("videoModel").value = settings.defaultVideoModel;
  $("textMode").value = settings.textMode || DEFAULT_TEXT_MODE;
  $("characterMode").value = settings.characterMode === "consistent" ? "consistent" : "random";
  $("sceneMode").value = settings.sceneMode === "continuous" ? "continuous" : "independent";
  $("concurrency").value = String(settings.concurrency || DEFAULT_CONCURRENCY);
  syncModelNote();
  if (settings.defaultImageModel) $("imageModel").value = settings.defaultImageModel;
  if (settings.aspect) $("aspect").value = settings.aspect;
  $("sceneCount").value = String(settings.sceneCount || 1);
  ui.sceneVideoPrompts = Array.from({ length: 10 }, (_, index) => String(settings.sceneVideoPrompts?.[index] || ""));
  applySceneModeRestriction();
  renderScenePromptInputs();
  $("extraPrompt").value = settings.extraPrompt || "";

  ui.settingsLoaded = true;
}

function sceneLabel(index, mode = $("sceneMode").value) {
  if (mode !== "continuous") return `ฉาก ${index + 1}`;
  if (index === 0) return "ฉาก 1 · Original";
  return `ฉาก ${index + 1} · Extended ครั้งที่ ${index}`;
}

function captureScenePromptInputs() {
  for (const input of document.querySelectorAll("[data-scene-prompt-index]")) {
    const index = Number(input.dataset.scenePromptIndex);
    if (Number.isInteger(index) && index >= 0 && index < 10) ui.sceneVideoPrompts[index] = input.value;
  }
}

function renderScenePromptInputs() {
  captureScenePromptInputs();
  const grid = $("sceneVideoPrompts");
  if (!grid) return;
  grid.replaceChildren();
  const mode = $("sceneMode").value === "continuous" ? "continuous" : "independent";
  const maxScenes = mode === "continuous" ? 3 : 10;
  const count = Math.max(1, Math.min(maxScenes, Number($("sceneCount").value) || 1));
  for (let index = 0; index < count; index += 1) {
    const textarea = el("textarea", {
      rows: 3,
      maxLength: 5000,
      value: ui.sceneVideoPrompts[index] || "",
      placeholder: mode === "continuous" && index > 0
        ? "เช่น ต่อบทพูดจากฉากก่อน เน้นผลลัพธ์ และห้ามพูดซ้ำ…"
        : "คำสั่งเสริมสำหรับวิดีโอฉากนี้…",
    });
    textarea.dataset.scenePromptIndex = String(index);
    textarea.addEventListener("input", debounce(() => {
      ui.sceneVideoPrompts[index] = textarea.value;
      persistSettings();
      refreshSampleBox();
    }, 300));
    grid.append(el("div", { className: "scene-prompt-field" }, [
      el("label", { textContent: sceneLabel(index, mode) }),
      textarea,
    ]));
  }
}

function applySceneModeRestriction() {
  const continuous = $("sceneMode").value === "continuous";
  const maxScenes = continuous ? 3 : 10;
  $("sceneCount").max = String(maxScenes);
  if ((Number($("sceneCount").value) || 1) > maxScenes) $("sceneCount").value = String(maxScenes);
  $("sceneModeNote").textContent = continuous
    ? "ฉากแรกเป็น Original และฉากถัดไปต่อจากเฟรมสุดท้ายด้วย Flow Extended (สูงสุด 3 ฉาก)"
    : "แต่ละฉากสร้าง Storyboard และวิดีโออิสระ แล้วรวมเป็นคลิปเดียว";
  $("sceneCountNote").textContent = continuous
    ? "รองรับ 1–3 ฉากต่อเนื่อง"
    : "รองรับ 1–10 ฉากอิสระ";
}

// Rebuilt whenever the snapshot lands, because the account tier decides whether the
// 0-credit models are offered at all.
function syncModelSelect() {
  const select = $("videoModel");
  const tier = ui.snapshot?.settings?.flowTier || "x20";
  const models = videoModelsForTier(tier);
  const keep = select.value;

  select.replaceChildren();
  let group = null;
  for (const m of models) {
    if (!group || group.label !== m.group) {
      group = el("optgroup", { label: m.group });
      select.append(group);
    }
    const cost = m.free ? "ฟรี" : `${m.credits} เครดิต`;
    group.append(el("option", {
      value: m.id,
      textContent: `${m.label} · ${cost}${m.recommended ? " · แนะนำ" : ""}`,
    }));
  }
  select.value = models.some((m) => m.id === keep) ? keep : DEFAULT_VIDEO_MODEL;
  syncModelNote();
}

function syncModelNote() {
  applyConcurrencyRestriction();
  applySceneModeRestriction();

  const m = videoModel($("videoModel").value);
  const textMode = $("textMode").value;
  const parts = [];
  if (m) {
    parts.push(`คลิปยาว ${m.seconds} วินาที`);
    parts.push("สร้างภาพ Storyboard ก่อน แล้วใช้เป็น reference ของวิดีโอ");
    if (m.note) parts.push(m.note);
  }
  $("videoModelNote").textContent = parts.join(" · ");
  $("imageModel").disabled = false;
  $("textModeNote").textContent = textMode === "noText"
    ? "ยังสร้าง Storyboard แต่ห้ามเพิ่มข้อความ โฆษณา หรือ caption บนจอ"
    : "AI จะแต่งหัวข้อโฆษณาใส่ภาพ Storyboard และคงข้อความให้ชัดเจน";
}

// Above 1 concurrent queue, only R2V models are selectable — I2V's extra
// generateImage() call roughly doubles Flow traffic per concurrent slot, and a burst
// of simultaneous calls is what actually trips Flow's bot detector. Greys out every
// other option and bails a now-disallowed pick onto the first still-allowed one.
function applyConcurrencyRestriction() {
  const select = $("videoModel");
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number($("concurrency").value) || 1));
  const restricted = concurrency > 1;

  for (const opt of select.querySelectorAll("option")) {
    opt.disabled = restricted && !CONCURRENT_SAFE_MODELS.includes(opt.value);
  }
  if (restricted && !CONCURRENT_SAFE_MODELS.includes(select.value)) {
    const fallback = [...select.querySelectorAll("option")].find((o) => !o.disabled);
    if (fallback) {
      select.value = fallback.value;
      toast(`ตั้งคิวพร้อมกัน ${concurrency} คิว — สลับโมเดลวิดีโอไปที่ ${fallback.textContent} ให้อัตโนมัติ (โมเดลอื่นรันพร้อมกันไม่ได้)`);
    } else {
      toast("บัญชีนี้ไม่มีโมเดลที่ปลอดภัยสำหรับรันพร้อมกัน — ลดจำนวนคิวพร้อมกันเหลือ 1", true);
    }
  }
  $("concurrencyNote").textContent = restricted
    ? "รันพร้อมกันได้เฉพาะ Omni Flash / Veo 3.1 Lite ฟรี — โมเดลอื่นถูกปิดไว้"
    : `รันทีละงาน (ปลอดภัยสุด) — เพิ่มได้สูงสุด ${MAX_CONCURRENCY} คิวพร้อมกัน`;
}

// Random-sample preview: picks a few scanned products and shows what the CURRENT
// settings would send for each. Purely exploratory — never touches the queue.
function sampleProducts(n = 3) {
  const products = ui.snapshot?.products || [];
  if (!products.length) {
    ui.samplePicks = [];
    $("sampleBox").replaceChildren(el("div", { className: "empty", textContent: "ยังไม่มีสินค้า — ไปสแกนก่อน" }));
    return;
  }
  const shuffled = [...products].sort(() => Math.random() - 0.5);
  ui.samplePicks = shuffled.slice(0, Math.min(n, shuffled.length));
  renderSampleBox();
}

// Re-render the CURRENTLY shown sample products (no re-pick) — called whenever a
// setting changes, so the preview reacts live without needing a fresh 🎲 roll.
function refreshSampleBox() {
  if (ui.samplePicks.length) renderSampleBox();
}

// Test-image results, keyed by product id, so a re-render triggered by a settings
// change (refreshSampleBox) doesn't wipe out a result the operator just generated.
// Value is {url, mediaId} or {error}; absent while a test is still in flight (the
// button's own disabled+label state is the loading cue — see the click handler).
ui.testImages = ui.testImages || {};

function renderSampleBox() {
  const box = $("sampleBox");
  box.replaceChildren();

  const textMode = $("textMode").value;
  const noText = textMode === "noText";
  for (const product of ui.samplePicks) {
    const built = buildPrompt({
      product, direction: ui.direction,
      videoModel: $("videoModel").value, extraPrompt: $("extraPrompt").value, textMode,
    });

    const promptHead = el("div", { className: "row", style: "justify-content: space-between; align-items: center;" }, [
      el("label", { className: "prompt-label", textContent: "Prompt ภาพ" }),
    ]);

    // Available in BOTH text modes, independent of the selected video model — even a
    // model whose real job skips this step (R2V always; any model under "ไม่มีข้อความ")
    // still benefits from previewing what that step would produce. What differs is
    // what "test" means: "มีข้อความ" calls Flow for a real AI-composed-banner
    // generation; "ไม่มีข้อความ" has no image prompt to generate at all (buildPrompt()
    // never builds one in that mode — shared/prompt.mjs), so instead it just shows
    // the product's own photo — literally what a real "ไม่มีข้อความ" job uses as its
    // start frame, no Flow call/credit needed.
    //
    // Rely on withBusy's own button-level disable+label for the "in progress" cue
    // rather than re-rendering the card mid-flight — a re-render here would replace
    // this exact button node with a fresh (non-disabled) one, since renderSampleBox
    // rebuilds the whole card from scratch, defeating the disable and letting a
    // double-click fire a second (costly, credit-consuming) generate call.
    const testBtn = el("button", { className: "ghost test-image-btn", type: "button", textContent: "🧪 ทดสอบสร้างรูป" });
    testBtn.addEventListener("click", withBusy(testBtn, "กำลังสร้าง… (อาจหลายสิบวินาที)", async () => {
      const characterMode = $("characterMode").value === "consistent" ? "consistent" : "random";
      try {
        const out = await api("/api/test-image", {
          method: "POST",
          body: {
            productId: product.id, direction: ui.direction, characterMode,
            imageModel: $("imageModel").value, aspect: $("aspect").value,
            extraPrompt: $("extraPrompt").value,
          },
        });
        ui.testImages[product.id] = { ...out, textMode, characterMode };
      } catch (err) {
        ui.testImages[product.id] = { error: err.message, textMode, characterMode };
        toast(err.message, true);
      }
      renderSampleBox();
    }));
    promptHead.append(testBtn);

    const card = el("div", { className: "sample-card" }, [
      el("div", { className: "sample-card-head" }, [
        el("img", { src: product.images?.[0] || product.image || "", alt: "", loading: "lazy" }),
        el("span", { textContent: product.name }),
      ]),
      promptHead,
      el("pre", {
        className: "preview",
        textContent: built.imagePrompt,
      }),
    ]);

    // Tagged with the mode it was produced under — a result from the OTHER mode
    // (e.g. a with-text test still cached after switching to "ไม่มีข้อความ") must not
    // show here, or it'd sit right under a message describing the wrong mode again.
    const raw = ui.testImages[product.id];
    const characterMode = $("characterMode").value === "consistent" ? "consistent" : "random";
    const result = raw?.textMode === textMode && raw?.characterMode === characterMode ? raw : null;
    if (result?.error) {
      card.append(el("p", { className: "job-err test-image-status", textContent: result.error }));
    } else if (result?.url) {
      card.append(el("div", { className: "test-image-result" }, [
        result.characterImageUrl ? el("p", { className: "muted", textContent: "สร้างภาพตัวละครอ้างอิงก่อน แล้วจึงสร้าง Storyboard ด้านล่าง" }) : null,
        el("img", { src: result.url, alt: "ผลทดสอบสร้างรูป Storyboard", loading: "lazy" }),
        el("a", { href: result.url, target: "_blank", rel: "noreferrer", className: "tag", textContent: "เปิดรูปเต็ม" }),
      ]));
    }

    const sceneMode = $("sceneMode").value === "continuous" ? "continuous" : "independent";
    const maxScenes = sceneMode === "continuous" ? 3 : 10;
    const sceneCount = Math.max(1, Math.min(maxScenes, Number($("sceneCount").value) || 1));
    for (let index = 0; index < sceneCount; index += 1) {
      let defaultPrompt = built.videoPrompt;
      if (sceneMode === "continuous") {
        defaultPrompt = index === 0
          ? [`Scene 1/${sceneCount} — BASE SCENE`, "ล็อกตัวละคร ใบหน้า เสียง สินค้า เสื้อผ้า ฉาก แสง และมุมกล้องนี้ไว้สำหรับฉากถัดไป", built.videoPrompt].join("\n")
          : buildTripleBotExtendedPrompt({ sceneIndex: index, sceneCount, direction: ui.direction, product });
      }
      const custom = String(ui.sceneVideoPrompts[index] || "").trim();
      const resolved = custom && !(sceneMode === "continuous" && index > 0)
        ? `${defaultPrompt}\n\nUSER VIDEO PROMPT — SCENE ${index + 1}:\n${custom}`
        : sceneMode === "continuous" && index > 0
          ? buildTripleBotExtendedPrompt({ sceneIndex: index, sceneCount, direction: ui.direction, product, sceneInstruction: custom })
          : defaultPrompt;
      card.append(
        el("label", { className: "prompt-label", textContent: `Prompt วิดีโอ · ${sceneLabel(index, sceneMode)}` }),
        el("pre", { className: "preview", textContent: resolved }),
      );
    }
    box.append(card);
  }
}

$("sampleBtn").addEventListener("click", () => sampleProducts(1));

// ───────────────────────────────────────────────────────── 4. queue page
const STATUS_LABEL = {
  queued: "รอคิว", running: "กำลังทำ", done: "เสร็จ", failed: "ล้มเหลว", cancelled: "ยกเลิก",
};

function renderJobs() {
  const list = $("jobList");
  const jobs = ui.snapshot?.jobs || [];
  const runner = ui.snapshot?.runner || {};
  list.replaceChildren();

  const counts = jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {});
  $("queueCounts").textContent = Object.keys(STATUS_LABEL)
    .filter((k) => counts[k])
    .map((k) => `${STATUS_LABEL[k]} ${counts[k]}`)
    .join(" · ") || "ยังไม่มีงาน";

  $("runQueue").disabled = runner.draining || !(counts.queued > 0);
  $("stopQueue").disabled = !runner.draining;
  $("runQueue").textContent = runner.draining ? "กำลังรัน…" : "▶ รันคิว";

  // Only worth showing when there's actually something to act on (operator's
  // explicit call) — no failed jobs means nothing for either button to do.
  const hasFailed = Boolean(counts.failed);
  $("clearFailed").hidden = !hasFailed;
  $("retryAllFailed").hidden = !hasFailed;

  // "done" jobs drop off this list the moment they finish — they're already safe
  // in History (server/store.mjs's history(), independent of this jobs list) with
  // their own ▶ ดูวิดีโอ. "failed"/"cancelled" stay here on purpose (operator's
  // explicit call) since ลองใหม่ only lives on this card, not on History's.
  const visible = jobs.filter((j) => j.status !== "done");
  if (!visible.length) {
    list.append(el("div", { className: "empty", textContent: "ยังไม่มีงานในคิว" }));
    return;
  }

  for (const j of visible) {
    const actions = el("div", { className: "row" });
    if (j.finalVideoUrl || j.videoUrl) {
      const play = el("button", { className: "ghost", type: "button", textContent: "▶ ดูวิดีโอ" });
      play.addEventListener("click", () => openVideoModal(j));
      actions.append(play);
    }
    if (j.status === "failed" || j.status === "cancelled") {
      const retry = el("button", { className: "ghost", textContent: "ลองใหม่" });
      retry.addEventListener("click", () => api("/api/jobs/retry", { method: "POST", body: { id: j.id } }).catch((e) => toast(e.message, true)));
      actions.append(retry);
    }
    if (j.status === "queued" || j.status === "running") {
      const cancel = el("button", { className: "ghost danger", textContent: "ยกเลิก" });
      cancel.addEventListener("click", () => api("/api/jobs/cancel", { method: "POST", body: { id: j.id } }).catch((e) => toast(e.message, true)));
      actions.append(cancel);
    }

    const model = videoModel(j.videoModel);
    const sceneCount = j.sceneCount || 1;
    const textBadge = j.textMode === "noText" ? "ไม่มีข้อความ" : j.textMode === "withText" ? "มีข้อความ" : null;
    list.append(el("div", { className: "item job" }, [
      el("img", { src: j.thumb || "", alt: "", loading: "lazy" }),
      el("div", {}, [
        el("h3", {}, [
          j.orderNumber ? el("span", { className: "tag order-tag", textContent: j.orderNumber }) : null,
          el("span", { textContent: j.title }),
        ]),
        el("div", { className: "meta" }, [
          el("span", { textContent: model ? `${model.label} · ${model.free ? "ฟรี" : `${model.credits} เครดิต`}` : j.videoModel }),
          textBadge ? el("span", { className: `tag text-mode-tag ${j.textMode}`, textContent: textBadge }) : null,
          sceneCount > 1 ? el("span", { textContent: `${sceneCount} ฉาก · ${j.sceneMode === "continuous" ? "Extended ต่อเนื่อง" : "แยกฉาก"}` }) : null,
          j.characterMode === "consistent" ? el("span", { className: "tag", textContent: "ตัวละครคนเดียวกัน" }) : null,
          el("span", { textContent: directionSummary(j.direction) }),
        ]),
        j.finalVideoPath ? el("div", { className: "muted local-path", textContent: `ไฟล์: ${j.finalVideoPath}` }) : null,
        j.error ? el("div", { className: "job-err", textContent: j.error }) : null,
      ]),
      el("div", { className: "status-col" }, [
        el("span", { className: `status ${j.status}`, textContent: STATUS_LABEL[j.status] || j.status }),
        j.status === "running" && j.startedAt ? jobTimer(j.startedAt) : null,
      ]),
      actions,
    ]));
  }
}

// `el()`'s Object.assign can't set .dataset (it's a read-only accessor on the DOM
// node) — build the timer span directly and set the dataset property afterward.
function jobTimer(startedAt) {
  const span = el("span", { className: "job-timer", textContent: formatDuration(Date.now() - startedAt) });
  span.dataset.started = String(startedAt);
  return span;
}

// Ticks every .job-timer element's text once a second, purely client-side — the
// bridge only pushes a fresh snapshot every ~30s while a job is mid-poll (see
// runner.mjs's pollUntilDone), which is far too coarse for a live-feeling timer.
setInterval(() => {
  const now = Date.now();
  for (const node of document.querySelectorAll(".job-timer")) {
    const started = Number(node.dataset.started);
    if (started) node.textContent = formatDuration(now - started);
  }
}, 1000);

// ───────────────────────────────────────────────────────── 5. history page
// One row per order number — what got generated, with-text or not, and how long
// the whole run took start-to-finish. Reads store.history() (server/store.mjs),
// a durable log recorded when a job finishes — separate from ui.snapshot.jobs,
// which is just the Queue's working list and gets emptied by its "ล้างงานที่จบแล้ว"
// button. Rendering off `jobs` directly used to mean clearing the Queue silently
// wiped this page too, since there was nowhere else the data lived.
ui.historyFilter = ui.historyFilter || "all";   // "all" | "done" | "failed" | "cancelled"

function renderHistory() {
  const list = $("historyList");
  const all = ui.snapshot?.history || [];
  const jobs = ui.historyFilter === "all" ? all : all.filter((j) => j.status === ui.historyFilter);
  list.replaceChildren();

  for (const btn of $("historyFilter").children) {
    btn.classList.toggle("on", btn.dataset.filter === ui.historyFilter);
  }

  if (!all.length) {
    list.append(el("div", { className: "empty", textContent: "ยังไม่มีประวัติ — สร้างวิดีโอสักงานก่อน" }));
    return;
  }
  if (!jobs.length) {
    list.append(el("div", { className: "empty", textContent: "ไม่มีงานในหมวดนี้" }));
    return;
  }

  for (const j of jobs) {
    const sceneCount = j.sceneCount || 1;
    const textBadge = j.textMode === "noText" ? "ไม่มีข้อความ" : j.textMode === "withText" ? "มีข้อความ" : null;

    let durationNode;
    if (j.status === "running" && j.startedAt) {
      durationNode = jobTimer(j.startedAt);
    } else if (j.startedAt && j.finishedAt) {
      durationNode = el("span", { textContent: formatDuration(j.finishedAt - j.startedAt) });
    } else {
      durationNode = el("span", { className: "muted", textContent: "—" });
    }

    list.append(el("div", { className: "item job" }, [
      el("img", { src: j.thumb || "", alt: "", loading: "lazy" }),
      el("div", {}, [
        el("h3", {}, [
          el("span", { className: "tag order-tag", textContent: j.orderNumber }),
          el("span", { textContent: j.title }),
        ]),
        el("div", { className: "meta" }, [
          textBadge ? el("span", { className: `tag text-mode-tag ${j.textMode}`, textContent: textBadge }) : null,
          sceneCount > 1 ? el("span", { textContent: `${sceneCount} ฉาก · ${j.sceneMode === "continuous" ? "Extended ต่อเนื่อง" : "แยกฉาก"}` }) : null,
          j.characterMode === "consistent" ? el("span", { className: "tag", textContent: "ตัวละครคนเดียวกัน" }) : null,
          el("span", {}, [`ใช้เวลา `, durationNode]),
        ]),
        j.finalVideoPath ? el("div", { className: "muted local-path", textContent: `ไฟล์: ${j.finalVideoPath}` }) : null,
        j.error ? el("div", { className: "job-err", textContent: j.error }) : null,
      ]),
      el("span", { className: `status ${j.status}`, textContent: STATUS_LABEL[j.status] || j.status }),
      (j.finalVideoUrl || j.videoUrl) ? (() => {
        const play = el("button", { className: "ghost", type: "button", textContent: "▶ ดูวิดีโอ" });
        play.addEventListener("click", () => openVideoModal(j));
        return play;
      })() : null,
    ]));
  }
}

$("historyFilter").addEventListener("click", (e) => {
  const filter = e.target.closest("button")?.dataset.filter;
  if (!filter || filter === ui.historyFilter) return;
  ui.historyFilter = filter;
  renderHistory();
});

// Per-status only — no "clear all" button exists on purpose (operator's explicit
// call: ลบงานที่สำเร็จ/ล้มเหลว/ยกเลิก are three separate, independent actions).
const HISTORY_CLEAR_LABEL = { done: "สำเร็จ", failed: "ล้มเหลว", cancelled: "ยกเลิก" };
$("historyClearBar").addEventListener("click", async (e) => {
  const status = e.target.closest("button")?.dataset.clear;
  if (!status) return;
  const count = (ui.snapshot?.history || []).filter((h) => h.status === status).length;
  if (!count) return toast(`ไม่มีงานที่${HISTORY_CLEAR_LABEL[status]}ในประวัติ`, true);
  if (!confirm(`ลบประวัติงานที่${HISTORY_CLEAR_LABEL[status]}ทั้งหมด ${count} รายการ? ลบแล้วกู้คืนไม่ได้`)) return;
  const out = await api("/api/history", { method: "DELETE", body: { status } });
  toast(`ลบประวัติงานที่${HISTORY_CLEAR_LABEL[status]}แล้ว (${out.removed})`);
});

function directionSummary(direction = {}) {
  const parts = [];
  for (const [field] of DIRECTION_FIELDS) {
    const v = direction[field];
    if (!v) continue;
    const label = v.startsWith(CUSTOM_PREFIX)
      ? v.slice(CUSTOM_PREFIX.length)
      : (STYLE_OPTIONS[field] || []).find(([id]) => id === v)?.[1] || v;
    parts.push(label);
  }
  return parts.join(" · ") || "AI เลือกให้ทั้งหมด";
}

$("runQueue").addEventListener("click", async () => {
  try {
    await api("/api/queue/run", { method: "POST" });
    toast("เริ่มรันคิว");
  } catch (err) { toast(err.message, true); }
});
$("stopQueue").addEventListener("click", async () => {
  await api("/api/queue/stop", { method: "POST" });
  toast("ขอหยุดคิวแล้ว — จะหยุดหลังจบงานที่กำลังทำ");
});
$("clearJobs").addEventListener("click", async () => {
  await api("/api/jobs", { method: "DELETE", body: {} });
  toast("ล้างงานที่จบแล้ว");
});
$("clearFailed").addEventListener("click", async () => {
  const failedIds = (ui.snapshot?.jobs || []).filter((j) => j.status === "failed").map((j) => j.id);
  if (!failedIds.length) return;
  await api("/api/jobs", { method: "DELETE", body: { ids: failedIds } });
  toast(`ล้างงานที่ล้มเหลวแล้ว (${failedIds.length})`);
});
$("retryAllFailed").addEventListener("click", async () => {
  const count = (ui.snapshot?.jobs || []).filter((j) => j.status === "failed").length;
  if (!count) return;
  await api("/api/jobs/retry", { method: "POST", body: {} });
  toast(`ลองใหม่แล้ว (${count})`);
});

// เริ่มคิวอัตโนมัติเมื่อส่งงานเข้าคิว — a pure client-side preference (localStorage,
// not server settings), so each operator's browser remembers its own choice.
// Checked once here and again right after every successful job-submit call (the
// per-product "สร้างวิดีโอ" button, "ส่งสร้างวิดีโอทั้งหมด", and search page's
// "ส่งไปคิว") — startQueue() server-side is already a no-op if a run is in
// progress, so calling it opportunistically here is safe even mid-run.
const AUTO_PLAY_KEY = "bsp_autoPlay";
const autoPlayBox = $("autoPlay");
try { autoPlayBox.checked = localStorage.getItem(AUTO_PLAY_KEY) === "1"; } catch { /* private mode etc. */ }
autoPlayBox.addEventListener("change", () => {
  try { localStorage.setItem(AUTO_PLAY_KEY, autoPlayBox.checked ? "1" : "0"); } catch { /* best effort */ }
});
async function maybeAutoRunQueue() {
  if (!autoPlayBox.checked) return;
  try { await api("/api/queue/run", { method: "POST" }); } catch { /* surfaced already by the submit call's own toast */ }
}

// ───────────────────────────────────────────────────────── log dock
// Two-mode split like ref1's TikTok-post log popup ("ทั่วไป"/"Dev" tabs): ทั่วไป
// shows the plain progress narrative an operator actually needs (ค้นหา…, สแกนแล้ว…,
// เสร็จ…, ล้มเหลว… — all info/warn/error entries); Dev adds back the noisy per-request
// API trace ("debug" level — one line per fetch, URL + duration + outcome) that
// answers "ดึง API มาไหม" but is too dense for day-to-day use.
function logOpen() {
  return localStorage.getItem("bsp.log.open") === "1";
}

function setLogOpen(open) {
  localStorage.setItem("bsp.log.open", open ? "1" : "0");
  $("logBackdrop").hidden = !open;
  $("logBody").hidden = !open;
  $("logToggle").setAttribute("aria-expanded", String(open));
  if (open) renderLog();
}

function logMode() {
  return localStorage.getItem("bsp.log.mode") === "dev" ? "dev" : "general";
}

function setLogMode(mode) {
  localStorage.setItem("bsp.log.mode", mode);
  $("logModeGeneral").classList.toggle("on", mode === "general");
  $("logModeDev").classList.toggle("on", mode === "dev");
  renderLog();
}

function visibleEntries() {
  const dev = logMode() === "dev";
  const needle = $("logFilter").value.trim().toLowerCase();
  return (ui.snapshot?.log || []).filter((e) => {
    if (!dev && e.level === "debug") return false;
    return !needle || e.msg.toLowerCase().includes(needle);
  });
}

// One dense row per entry (time gutter · level mark · message) instead of a card,
// and — the actual cure for the freeze — rows are APPENDED, not rebuilt. The old
// renderer re-created every visible entry on every SSE "state" event: ~300 cards ×
// ~6 nodes, plus a JSON.stringify per Dev-mode entry, thrown away and built again,
// even though only the last line or two had changed. State events land at least
// every 25s from the extension long-poll and far more often mid-queue (every /ext/
// poll and every runner onChange pushes one), so with the popup open that rebuild
// was running in bursts.
const LOG_MARK = { info: "·", warn: "!", error: "✕", debug: "›" };

// Rows are capped independently of the server's logTail(300) so a later bump there
// can't silently hand the DOM thousands of rows.
const MAX_ROWS = 300;

// HH:MM:SS in a fixed-width gutter. Absolute, not relative ("3 นาทีที่แล้ว"), on
// purpose: relative text is stale the moment it's painted, so keeping it honest means
// re-rendering rows that never changed — exactly the work being removed here. The
// full date lives on the row's title attribute.
function clockTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// Row identity. Two entries logged in the same millisecond at the same level with the
// same text render byte-identical rows, so a key collision changes nothing on screen.
const logKey = (e) => `${e.ts}|${e.level || "info"}|${e.msg}`;

// What the rows currently in the DOM were built from. `signature` covers everything
// that changes how a row is BUILT (mode, filter) rather than which rows exist — a
// change there forces a full rebuild; otherwise new tail entries just get appended.
let renderedKeys = [];
let renderedSignature = "";

/** How many leading rows must be dropped for the rows already in the DOM to line up
 *  as a prefix of `keys` — i.e. the log only grew at the tail and possibly slid out
 *  of the window at the head, so the DOM can be patched. Returns -1 when they don't
 *  line up at all (log cleared, entries reordered), meaning a rebuild is the only
 *  correct answer. */
function alignRendered(rendered, keys) {
  // An empty DOM falls out as -1 below (indexOf on []), which is what we want: with
  // nothing rendered there may still be a placeholder row to clear, so rebuild.
  const drop = rendered.indexOf(keys[0]);
  if (drop < 0) return -1;
  const kept = rendered.length - drop;
  if (kept > keys.length) return -1;
  for (let i = 0; i < kept; i += 1) if (rendered[drop + i] !== keys[i]) return -1;
  return drop;
}

function logRow(entry, dev) {
  const level = entry.level || "info";
  const row = el("div", { className: `log-row ${level}`, title: new Date(entry.ts).toLocaleString("th-TH") }, [
    el("span", { className: "log-time", textContent: clockTime(entry.ts) }),
    el("span", { className: "log-mark", textContent: LOG_MARK[level] || "·" }),
    el("span", { className: "log-msg", textContent: entry.msg }),
  ]);

  // Dev metadata is built ONLY when expanded — that stringify used to run for every
  // metadata-carrying entry on every render, whether or not anyone looked at it.
  if (dev && entry.meta) {
    const toggle = el("button", { className: "log-more", type: "button", textContent: "⌄", title: "ดูรายละเอียด" });
    let detail = null;
    toggle.addEventListener("click", () => {
      if (!detail) {
        const { stage, ...rest } = entry.meta;
        detail = el("pre", { className: "log-detail" });
        detail.textContent = [
          stage ? `event: ${stage}` : "",
          Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "",
        ].filter(Boolean).join("\n");
        row.append(detail);
      }
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.textContent = open ? "⌃" : "⌄";
      toggle.classList.toggle("on", open);
    });
    row.append(toggle);
  }
  return row;
}

function renderLog() {
  // Badge and status dot stay live even while the popup is closed.
  const all = ui.snapshot?.log || [];
  const errors = all.filter((e) => e.level === "error").length;
  const badge = $("logBadge");
  badge.textContent = errors ? `${errors} error` : `${all.length} บรรทัด`;
  badge.className = errors ? "has-err" : "";
  $("logDot").className = `dot ${errors ? "off" : "on"}`;

  // Closed popup: nothing below is observable, and renderedKeys is intentionally left
  // alone so it still describes what's actually in the DOM when it reopens.
  if ($("logBody").hidden) return;

  const list = $("log");
  const dev = logMode() === "dev";
  const entries = visibleEntries().slice(-MAX_ROWS);

  if (!entries.length) {
    list.replaceChildren(el("div", { className: "log-empty", textContent: "— ไม่มีบรรทัดที่ตรงกับตัวกรอง —" }));
    renderedKeys = [];
    renderedSignature = "";
    return;
  }

  // Follow only when already parked at the bottom, so scrolling up to read something
  // isn't yanked back down by the next state event. The checkbox stays an explicit
  // opt-out of following at all.
  const stick = $("logFollow").checked
    && list.scrollHeight - list.scrollTop - list.clientHeight < 40;

  const keys = entries.map(logKey);
  const signature = `${dev ? "dev" : "general"}|${$("logFilter").value.trim().toLowerCase()}`;
  const drop = signature === renderedSignature ? alignRendered(renderedKeys, keys) : -1;

  if (drop < 0) {
    list.replaceChildren(...entries.map((e) => logRow(e, dev)));
  } else {
    // Rows that slid out of the window at the head, then only the genuinely new tail.
    for (let i = 0; i < drop; i += 1) list.firstChild?.remove();
    const kept = renderedKeys.length - drop;
    for (let i = kept; i < entries.length; i += 1) list.append(logRow(entries[i], dev));
  }
  renderedKeys = keys;
  renderedSignature = signature;

  if (stick) list.scrollTop = list.scrollHeight;
}

$("logToggle").addEventListener("click", () => setLogOpen($("logBody").hidden));
$("logModeGeneral").addEventListener("click", () => setLogMode("general"));
$("logModeDev").addEventListener("click", () => setLogMode("dev"));
$("logFilter").addEventListener("input", debounce(renderLog, 200));
$("logFollow").addEventListener("change", renderLog);
$("logCopy").addEventListener("click", async () => {
  const entries = visibleEntries();
  const text = entries
    .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.msg}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast(`คัดลอก log ${entries.length} บรรทัด`);
  } catch {
    toast("คัดลอกไม่ได้ — เบราว์เซอร์บล็อก clipboard", true);
  }
});
$("logClear").addEventListener("click", async () => {
  if (!confirm("ล้าง log ทั้งหมด?")) return;
  await api("/api/log", { method: "DELETE" }).catch((err) => toast(err.message, true));
});
$("logCloseBtn").addEventListener("click", () => setLogOpen(false));
$("logBackdrop").addEventListener("click", (e) => { if (e.target === $("logBackdrop")) setLogOpen(false); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("videoBackdrop").hidden) closeVideoModal();
  else if (!$("logBackdrop").hidden) setLogOpen(false);
});

// ───────────────────────────────────────────────────────── video popup
// Plays the local downloaded file (j.finalVideoUrl, served from the bridge's own
// Generated Media folder) instead of opening a new tab — falls back to the remote
// Flow URL for jobs finished before the local-download feature existed.
function openVideoModal(job) {
  const src = job.finalVideoUrl || job.videoUrl;
  if (!src) return;
  $("videoModalTitle").textContent = job.orderNumber ? `${job.orderNumber} — ${job.title}` : job.title;
  const player = $("videoModalPlayer");
  player.src = src;
  $("videoBackdrop").hidden = false;
  player.play().catch(() => {});
}

function closeVideoModal() {
  $("videoBackdrop").hidden = true;
  const player = $("videoModalPlayer");
  player.pause();
  player.removeAttribute("src");
  player.load();
}

$("videoCloseBtn").addEventListener("click", closeVideoModal);
$("videoBackdrop").addEventListener("click", (e) => { if (e.target === $("videoBackdrop")) closeVideoModal(); });

// ───────────────────────────────────────────────────────── boot
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

renderDirection();
renderModelSelects();
renderSearch();
setLogMode(logMode());
setLogOpen(logOpen());

api("/api/state").then((snapshot) => {
  ui.snapshot = snapshot;
  renderWeights();
  renderLink();
  renderProducts();
  renderJobs();
  renderLog();
  applySettingsToForm(snapshot.settings);
  // Restore the last search so a reload does not lose the research pass.
  const last = snapshot.searches?.[0];
  if (last) {
    ui.searchItems = last.items || [];
    $("keyword").value = last.keyword || "";
    renderSearch();
  }
}).catch((err) => toast(`โหลดสถานะไม่ได้: ${err.message}`, true));

connectEvents();
