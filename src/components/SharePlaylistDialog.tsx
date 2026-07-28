import {useEffect, useState} from "react";
import {Check, Copy, LoaderCircle, Share2, X} from "lucide-react";

export type ShareDialogState =
  | {
      phase: "working";
      playlistName: string;
      status: string;
      /** 0–1 progress when known */
      progress?: number;
      debug?: string;
    }
  | {
      phase: "done";
      playlistName: string;
      code: string;
      expiresAt: string;
      status?: string;
      progress?: number;
      debug?: string;
    }
  | {
      phase: "error";
      playlistName: string;
      error: string;
      status?: string;
      progress?: number;
      debug?: string;
    };

type Props = {
  state: ShareDialogState;
  onClose: () => void;
};

export function SharePlaylistDialog({state, onClose}: Props) {
  const [copied, setCopied] = useState(false);
  const busy = state.phase === "working";
  const progress = typeof state.progress === "number" ? Math.max(0, Math.min(1, state.progress)) : null;

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
            <div className="playlist-share-bar" aria-hidden={progress == null}>
              <div
                className="playlist-share-bar-fill"
                style={{width: `${Math.round((progress ?? 0.08) * 100)}%`}}
              />
            </div>
            <p className="playlist-share-bar-label mono">
              {progress != null ? `${Math.round(progress * 100)}%` : "…"}
              {" · "}each track is a separate upload (Railway 5‑min body limit)
            </p>
            {state.debug ? <pre className="playlist-share-debug">{state.debug}</pre> : null}
            <p className="save-hint">
              Tracks upload one-by-one so large playlists do not hit the 5‑minute single-request cap.
              First share after idle may take a few extra seconds to wake the server.
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
            {state.debug ? <pre className="playlist-share-debug">{state.debug}</pre> : null}
          </>
        ) : null}

        {state.phase === "error" ? (
          <>
            <p className="playlist-share-error">{state.error}</p>
            {state.status ? <p className="save-hint">Last step: {state.status}</p> : null}
            {state.debug ? <pre className="playlist-share-debug">{state.debug}</pre> : null}
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
