import {CloudUpload} from "lucide-react";

export function DropOverlay({visible}: {visible: boolean}) {
  if (!visible) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay-card">
        <CloudUpload size={34} strokeWidth={1.4} />
        <strong>Drop to add to your library</strong>
        <span>Audio files and folders</span>
      </div>
    </div>
  );
}
