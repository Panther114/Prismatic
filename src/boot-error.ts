const showStartupError = (value: unknown) => {
  const root = document.getElementById("root");
  if (!root || root.childElementCount) return;
  const error = value instanceof Error ? value : new Error(String(value || "Unknown startup error"));
  root.innerHTML = "";
  const panel = document.createElement("pre");
  panel.setAttribute("role", "alert");
  panel.style.cssText = "box-sizing:border-box;max-width:900px;margin:48px;padding:24px;white-space:pre-wrap;color:#ffd9dc;background:#211116;border:1px solid #7f3340;font:13px/1.5 monospace";
  panel.textContent = `Prismatic could not start.\n\n${error.stack || error.message}`;
  root.appendChild(panel);
};

window.addEventListener("error", (event) => showStartupError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => showStartupError(event.reason));
