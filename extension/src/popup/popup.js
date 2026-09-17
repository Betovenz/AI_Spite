// Popup: a read-only view of the link state plus a manual reconnect. All the real
// work lives in the service worker; this only asks it what it knows.

const $ = (id) => document.getElementById(id);

function paint(state) {
  const connected = Boolean(state.connected && state.bridgePort);
  $("dot").className = `dot ${connected ? "on" : "off"}`;
  $("ver").textContent = `v${state.version || "?"}`;
  $("bridge").textContent = connected
    ? `เชื่อมต่อ bridge ที่ 127.0.0.1:${state.bridgePort}`
    : "ยังไม่พบ bridge — เปิดเว็บ BlueSPite ก่อน";

  for (const [key, dotId, infoId] of [["shopee", "shopeeDot", "shopeeInfo"], ["flow", "flowDot", "flowInfo"]]) {
    const site = state.sites?.[key] || {};
    $(dotId).className = `dot small ${site.ok ? "on" : "off"}`;
    $(infoId).textContent = site.detail || "";
  }
  $("open").disabled = !connected;
  $("open").dataset.port = state.bridgePort || "";
}

function refresh() {
  chrome.runtime.sendMessage({ bsp: "popup.state" }, (state) => {
    if (state) paint(state);
  });
}

$("reconnect").addEventListener("click", () => {
  $("bridge").textContent = "กำลังค้นหา bridge…";
  chrome.runtime.sendMessage({ bsp: "popup.reconnect" }, () => refresh());
});

$("open").addEventListener("click", () => {
  const port = $("open").dataset.port;
  if (port) chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
});

refresh();
setInterval(refresh, 2000);
