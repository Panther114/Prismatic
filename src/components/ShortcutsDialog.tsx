import {X} from "lucide-react";
import {useEffect, useRef} from "react";
import {SHORTCUTS} from "../lib/shortcuts";

export function ShortcutsDialog({onClose}: {onClose: () => void}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = Array.from(new Set(SHORTCUTS.map((item) => item.group)));
  return (
    <div className="confirm-overlay" role="presentation" onClick={onClose}>
      <div className="confirm-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-dialog-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" ref={closeRef} className="confirm-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="shortcut-groups">
          {groups.map((group) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {SHORTCUTS.filter((item) => item.group === group).map((item) => (
                  <div key={item.action}><dt>{item.label}</dt><dd><kbd>{item.keys}</kbd></dd></div>
                ))}
              </dl>
            </section>
          ))}
          <p className="save-hint">Press 0–9 to jump to 0–90% of the track.</p>
        </div>
      </div>
    </div>
  );
}
