/**
 * Production playlist-share host (Railway share-only service).
 * Desktop always talks here; local web dev can use same-origin via empty base.
 */
export const DEFAULT_SHARE_API_BASE = "https://prismatic.up.railway.app";

const STORAGE_KEY = "prismatic.shareApiBase";

export function getConfiguredShareBase(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored?.trim()) return stored.trim().replace(/\/$/, "");
  } catch {
    // ignore
  }
  const fromEnv = typeof import.meta !== "undefined"
    ? String((import.meta as ImportMeta & {env?: {VITE_SHARE_API_BASE?: string}}).env?.VITE_SHARE_API_BASE || "").trim()
    : "";
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return DEFAULT_SHARE_API_BASE.replace(/\/$/, "");
}

export function setConfiguredShareBase(url: string) {
  try {
    localStorage.setItem(STORAGE_KEY, url.replace(/\/$/, ""));
  } catch {
    // ignore
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isColdStartFailure(error: unknown, status?: number): boolean {
  if (status === 502 || status === 503 || status === 504 || status === 521 || status === 522 || status === 523) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch")
    || message.includes("network")
    || message.includes("load failed")
    || message.includes("aborted")
    || message.includes("timeout")
    || message.includes("502")
    || message.includes("503")
    || message.includes("bad gateway")
  );
}

/**
 * Wake a Railway Serverless (slept) share host before a large upload.
 * Retries health until ok or attempts exhausted.
 */
export async function wakeShareHost(
  baseUrl: string,
  options: {onProgress?: (message: string) => void; attempts?: number} = {},
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
  const attempts = options.attempts ?? 6;
  options.onProgress?.("Waking share server…");

  for (let i = 0; i < attempts; i += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${base}/api/health`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        options.onProgress?.("Share server ready.");
        return;
      }
      if (!isColdStartFailure(null, response.status) && response.status < 500) {
        // 4xx means host is up but path wrong — stop spinning.
        throw new Error(`Share host health failed (${response.status}).`);
      }
    } catch (error) {
      if (i === attempts - 1) {
        // Last try: let the real upload attempt surface a clearer error.
        options.onProgress?.("Share server still starting — continuing…");
        return;
      }
      if (!isColdStartFailure(error)) {
        options.onProgress?.("Share server still starting — continuing…");
        return;
      }
    }
    options.onProgress?.(`Waking share server… (${i + 2}/${attempts})`);
    await sleep(1200 + i * 800);
  }
}

/**
 * fetch() with cold-start retries (502/network while Railway boots).
 * Does not clone FormData bodies more than needed — caller should rebuild FormData on retry for POST uploads.
 */
export async function fetchShareWithColdStart(
  url: string,
  init: RequestInit | undefined,
  options: {
    onProgress?: (message: string) => void;
    attempts?: number;
    /** Rebuild body for each attempt (required for FormData retries). */
    rebuildInit?: () => RequestInit | Promise<RequestInit>;
  } = {},
): Promise<Response> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const requestInit = options.rebuildInit ? await options.rebuildInit() : init;
      const response = await fetch(url, requestInit);
      if (response.ok || !isColdStartFailure(null, response.status)) {
        return response;
      }
      lastError = new Error(`Share host error (${response.status})`);
      if (i < attempts - 1) {
        options.onProgress?.(`Share server cold start — retry ${i + 2}/${attempts}…`);
        await sleep(1500 + i * 1000);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1 && isColdStartFailure(error)) {
        options.onProgress?.(`Share server cold start — retry ${i + 2}/${attempts}…`);
        await sleep(1500 + i * 1000);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function shareJsonWithColdStart<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  onProgress?: (message: string) => void,
): Promise<T> {
  const base = baseUrl.replace(/\/$/, "");
  await wakeShareHost(base, {onProgress});
  const response = await fetchShareWithColdStart(`${base}${path}`, init, {
    onProgress,
    rebuildInit: init ? () => init : undefined,
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        response.ok
          ? "Invalid JSON from share host"
          : `Share host error (${response.status})`,
      );
    }
  }
  if (!response.ok) {
    throw new Error((body as {error?: string} | null)?.error || `Share host error (${response.status})`);
  }
  return body as T;
}
