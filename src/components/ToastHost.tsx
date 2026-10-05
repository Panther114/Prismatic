import {X} from "lucide-react";
import {dismissToast, useToasts} from "../lib/toast";

export function ToastHost() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
          <span>{item.text}</span>
          {item.onAction && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                item.onAction?.();
                dismissToast(item.id);
              }}
            >
              {item.actionLabel || "Undo"}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => dismissToast(item.id)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
