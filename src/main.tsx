import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-sans/300.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/jetbrains-mono/400.css";
import App from "./App";
import "./styles.css";

/** Desktop shells must never use the web service worker; stale shells can mask upgrades. */
const isDesktop =
  typeof navigator !== "undefined"
  && (
    "__TAURI_INTERNALS__" in window
    || /\bElectron\//.test(navigator.userAgent)
    || new URLSearchParams(location.search).get("desktop") === "1"
  );

async function purgeServiceWorkers() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // ignore
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // ignore
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);

// Expose build version for desktop diagnostics
(window as unknown as {__APP_VERSION__?: string}).__APP_VERSION__ =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";

if (isDesktop) {
  // Always drop any service worker left over from older desktop builds.
  void purgeServiceWorkers();
} else if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}
