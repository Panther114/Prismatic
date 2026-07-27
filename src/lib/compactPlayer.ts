import {LogicalSize} from "@tauri-apps/api/dpi";
import {getCurrentWindow, type PhysicalSize} from "@tauri-apps/api/window";
import {isTauri} from "../api";

let previousSize: PhysicalSize | null = null;

export async function setCompactPlayer(compact: boolean) {
  document.documentElement.classList.toggle("compact-player-mode", compact);
  if (!isTauri) return;
  const window = getCurrentWindow();
  if (compact) {
    previousSize = await window.innerSize();
    await window.setMinSize(new LogicalSize(560, 150));
    await window.setSize(new LogicalSize(680, 170));
    await window.setResizable(false);
  } else {
    await window.setResizable(true);
    await window.setMinSize(new LogicalSize(840, 600));
    if (previousSize) await window.setSize(previousSize);
    previousSize = null;
    await window.center();
  }
}
