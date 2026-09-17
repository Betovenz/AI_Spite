// Bridge client: finds the local BlueSPite bridge, then keeps one long-poll open for
// commands. Port discovery mirrors the bridge's own fallback walk (DEFAULT_PORT ..
// DEFAULT_PORT+PORT_SCAN_SPAN), so neither side needs configuration.

import { DEFAULT_PORT, PORT_SCAN_SPAN, SERVICE } from "./protocol.js";

const HOST = "127.0.0.1";
const DISCOVERY_TIMEOUT_MS = 1500;

let basePort = 0;

export function baseUrl() {
  return basePort ? `http://${HOST}:${basePort}` : "";
}

async function probe(port, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${HOST}:${port}/ext/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json();
    // Guard against latching onto some unrelated dev server on the same port.
    return body?.service === SERVICE;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Locate the bridge. Re-checks the remembered port first, then scans the range. */
export async function connect(payload) {
  if (basePort && await probe(basePort, payload)) return basePort;
  for (let port = DEFAULT_PORT; port <= DEFAULT_PORT + PORT_SCAN_SPAN; port += 1) {
    if (await probe(port, payload)) {
      basePort = port;
      await chrome.storage.local.set({ bridgePort: port });
      return port;
    }
  }
  basePort = 0;
  return 0;
}

export async function restorePort() {
  const { bridgePort } = await chrome.storage.local.get("bridgePort");
  if (bridgePort) basePort = bridgePort;
  return basePort;
}

async function post(path, body) {
  if (!basePort) throw new Error("bridge not connected");
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Block until the bridge hands over a command, or resolve null when it times out. */
export async function pollCommand() {
  if (!basePort) throw new Error("bridge not connected");
  const res = await fetch(`${baseUrl()}/ext/poll`);
  if (!res.ok) throw new Error(`poll -> HTTP ${res.status}`);
  const body = await res.json();
  return body.command || null;
}

export function sendResult(id, result) {
  return post("/ext/result", { id, ok: true, result });
}

export function sendError(id, error) {
  return post("/ext/result", { id, ok: false, error: String(error?.message || error) });
}

export function sendStatus(sites, flowTier) {
  return post("/ext/status", { sites, flowTier }).catch(() => {});
}

export function sendLog(msg, level = "info") {
  return post("/ext/log", { msg, level }).catch(() => {});
}
