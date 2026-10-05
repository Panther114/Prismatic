import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWebview} from "@tauri-apps/api/webview";
import {useEffect, useRef} from "react";
import {isTauri} from "../api";

type Handlers = {
  /** Files the OS asked us to open ("Open with", double-click, command line). */
  onOpen: (paths: string[]) => void;
  /** Files dropped on the window. Native paths on desktop, File objects in a browser. */
  onDropPaths: (paths: string[]) => void;
  onDropFiles: (files: File[]) => void;
  onDragging: (active: boolean) => void;
  /** True once the library is loaded, so launch arguments can be applied. */
  ready: boolean;
};

/** Window-wide drag-and-drop plus OS "open with" for both desktop and browser builds. */
export function useExternalFiles(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!isTauri) {
      let depth = 0;
      const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
      const onEnter = (event: DragEvent) => {
        if (!hasFiles(event)) return;
        depth += 1;
        ref.current.onDragging(true);
      };
      const onLeave = (event: DragEvent) => {
        if (!hasFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) ref.current.onDragging(false);
      };
      const onOver = (event: DragEvent) => {
        if (hasFiles(event)) event.preventDefault();
      };
      const onDrop = (event: DragEvent) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth = 0;
        ref.current.onDragging(false);
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) ref.current.onDropFiles(files);
      };
      window.addEventListener("dragenter", onEnter);
      window.addEventListener("dragleave", onLeave);
      window.addEventListener("dragover", onOver);
      window.addEventListener("drop", onDrop);
      return () => {
        window.removeEventListener("dragenter", onEnter);
        window.removeEventListener("dragleave", onLeave);
        window.removeEventListener("dragover", onOver);
        window.removeEventListener("drop", onDrop);
      };
    }

    let disposed = false;
    const offs: Array<() => void> = [];
    void (async () => {
      const offOpen = await listen<string[]>("open-files", (event) => ref.current.onOpen(event.payload));
      const offDrag = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") ref.current.onDragging(true);
        else if (payload.type === "leave") ref.current.onDragging(false);
        else if (payload.type === "drop") {
          ref.current.onDragging(false);
          if (payload.paths.length) ref.current.onDropPaths(payload.paths);
        }
      });
      if (disposed) {
        offOpen();
        offDrag();
      } else {
        offs.push(offOpen, offDrag);
      }
    })();
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, []);

  // Files the app was launched with are held by Rust until the library is ready.
  useEffect(() => {
    if (!isTauri || !handlers.ready) return;
    void invoke<string[]>("take_pending_open").then((paths) => {
      if (paths.length) ref.current.onOpen(paths);
    });
  }, [handlers.ready]);
}
