import {useEffect, useState} from "react";
import {Check, Copy, LoaderCircle, Share2, X} from "lucide-react";

export type ShareDialogState =
  | {
      phase: "working";
      playlistName: string;
      status: string;
    }
  | {
      phase: "done";
      playlistName: string;
      code: string;
      expiresAt: string;
      status?: string;
    }
  | {
      phase: "error";
      playlistName: string;
      error: string;
      status?: string;
    };

type Props = {
  state: ShareDialogState;
  onClose: () => void;
};

export function SharePlaylistDialog({state, onClose}: Props) {
  const [copied, setCopied] = useState(false);
  const busy = state.phase === "working";

  useEffect(() => {
    setCopied(false);
  }, [state.phase, state.phase === "done" ? state.code : ""]);

  const copyCode = async () => {
    if (state.phase !== "done") return;
    try {
      await navigator.clipboard.writeText(state.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the code text for manual copy
      const el = document.getElementById("playlist-share-code-value");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  return (
    <div
      className="confirm-overlay playlist-share-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="confirm-dialog playlist-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-head">
          <h2 id="share-dialog-title">
            {state.phase === "working" && "Sharing playlist"}
            {state.phase === "done" && "Share code ready"}
            {state.phase === "error" && "Share failed"}
          </h2>
          <button
            type="button"
            className="confirm-close"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="playlist-share-name">
          <Share2 size={14} aria-hidden="true" />
          <strong>{state.playlistName}</strong>
        </p>

        {state.phase === "working" ? (
          <>
            <div className="playlist-share-progress" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={22} />
              <span>{state.status || "Working…"}</span>
            </div>
            <p className="save-hint">
              Packing tracks, waking the share server if it was asleep, then uploading original-quality audio.
              First share after idle can take a few seconds extra.
            </p>
          </>
        ) : null}

        {state.phase === "done" ? (
          <>
            <p>
              Give this code to another Prismatic desktop app. They use <strong>Playlists → Import code</strong>.
              Expires in 24 hours.
            </p>
            <div className="playlist-share-code-block">
              <p id="playlist-share-code-value" className="playlist-share-code" aria-label="Share code">
                {state.code}
              </p>
              <button type="button" className="playlist-share-copy-main" onClick={() => void copyCode()}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "Copied" : "Copy code"}
              </button>
            </div>
            <p className="save-hint">
              Expires {new Date(state.expiresAt).toLocaleString()}. Tracks stay full quality.
            </p>
          </>
        ) : null}

        {state.phase === "error" ? (
          <>
            <p className="playlist-share-error">{state.error}</p>
            {state.status ? <p className="save-hint">Last step: {state.status}</p> : null}
          </>
        ) : null}

        <div className="confirm-actions">
          {state.phase === "done" ? (
            <>
              <button type="button" className="confirm-cancel" onClick={() => void copyCode()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="confirm-ok" autoFocus onClick={onClose}>
                Done
              </button>
            </>
          ) : null}
          {state.phase === "error" ? (
            <button type="button" className="confirm-ok" autoFocus onClick={onClose}>
              Close
            </button>
          ) : null}
          {state.phase === "working" ? (
            <button type="button" className="confirm-cancel" disabled>
              Please wait…
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
