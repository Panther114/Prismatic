import {useEffect, useId, useState} from "react";
import {Download, LoaderCircle, RefreshCw, Sparkles, X} from "lucide-react";
import {
  appUpdater,
  formatBytes,
  type UpdateSnapshot,
} from "../lib/appUpdater";

type Props = {
  /** When true, forces the dialog open (e.g. Settings "Check for updates"). */
  forceOpen?: boolean;
  onClose?: () => void;
};

export function UpdateDialog({forceOpen = false, onClose}: Props) {
  const titleId = useId();
  const [snap, setSnap] = useState<UpdateSnapshot>(() => appUpdater.getSnapshot());
  const [busy, setBusy] = useState(false);

  useEffect(() => appUpdater.subscribe(setSnap), []);

  const autoOpen =
    snap.phase === "available" ||
    snap.phase === "downloading" ||
    snap.phase === "installing" ||
    snap.phase === "ready";

  const open = forceOpen || autoOpen;
  if (!open || !appUpdater.isDesktop()) return null;

  const canClose =
    snap.phase !== "downloading" &&
    snap.phase !== "installing" &&
    snap.phase !== "ready";

  const close = () => {
    if (!canClose) return;
    appUpdater.dismissAvailable();
    onClose?.();
  };

  const install = async () => {
    setBusy(true);
    try {
      await appUpdater.downloadAndInstall();
    } catch {
      /* error reflected in snapshot */
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    try {
      await appUpdater.checkForUpdates({reason: "manual"});
    } finally {
      setBusy(false);
    }
  };

  const percent = snap.progress.percent;
  const progressLabel =
    snap.progress.total != null
      ? `${formatBytes(snap.progress.downloaded)} / ${formatBytes(snap.progress.total)}`
      : snap.progress.downloaded > 0
        ? formatBytes(snap.progress.downloaded)
        : null;

  return (
    <div className="confirm-overlay update-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && canClose) close(); }}>
      <div
        className="confirm-dialog update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="confirm-dialog-head">
          <div className="update-dialog-title">
            <span className="update-dialog-badge" aria-hidden="true">
              <Sparkles size={14} />
            </span>
            <h2 id={titleId}>
              {snap.phase === "checking" && "Checking for updates"}
              {snap.phase === "available" && "Update available"}
              {snap.phase === "downloading" && "Downloading update"}
              {snap.phase === "installing" && "Installing update"}
              {snap.phase === "ready" && "Restarting…"}
              {snap.phase === "up-to-date" && "You're up to date"}
              {snap.phase === "error" && "Update check failed"}
              {snap.phase === "idle" && "Software update"}
            </h2>
          </div>
          {canClose && (
            <button type="button" className="confirm-close" onClick={close} aria-label="Close">
              <X size={16} />
            </button>
          )}
        </div>

        {snap.phase === "available" && (
          <>
            <p className="update-version-line">
              <span className="mono">{snap.currentVersion || "—"}</span>
              <span className="update-arrow" aria-hidden="true">→</span>
              <strong className="mono">{snap.availableVersion}</strong>
            </p>
            {snap.notes ? (
              <div className="update-notes">
                <strong>What's new</strong>
                <pre>{snap.notes}</pre>
              </div>
            ) : (
              <p>A newer version of Prismatic is ready. Your library and settings stay on this PC.</p>
            )}
          </>
        )}

        {(snap.phase === "downloading" || snap.phase === "installing" || snap.phase === "ready") && (
          <>
            <p>
              {snap.phase === "downloading" && "Downloading a signed update package…"}
              {snap.phase === "installing" && "Verifying signature and applying the update…"}
              {snap.phase === "ready" && "Update installed. Restarting Prismatic…"}
            </p>
            <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              <div className="update-progress-bar" style={{width: `${percent ?? (snap.phase === "installing" || snap.phase === "ready" ? 100 : 12)}%`}} />
            </div>
            <div className="update-progress-meta mono">
              <span>{percent != null ? `${percent}%` : snap.phase === "downloading" ? "…" : "100%"}</span>
              {progressLabel && <span>{progressLabel}</span>}
            </div>
          </>
        )}

        {snap.phase === "checking" && (
          <p className="update-checking">
            <LoaderCircle className="spin" size={16} />
            Contacting the release server…
          </p>
        )}

        {snap.phase === "up-to-date" && (
          <p>
            Prismatic <span className="mono">{snap.currentVersion}</span> is the latest release.
          </p>
        )}

        {snap.phase === "error" && (
          <p className="update-error">{snap.error || "Something went wrong while checking for updates."}</p>
        )}

        {snap.phase === "idle" && forceOpen && (
          <p>Check GitHub Releases for a newer desktop build. Updates are signed and verified before install.</p>
        )}

        <div className="confirm-actions">
          {canClose && (
            <button type="button" className="confirm-cancel" onClick={close}>
              {snap.phase === "available" ? "Later" : "Close"}
            </button>
          )}
          {(snap.phase === "error" || snap.phase === "up-to-date" || snap.phase === "idle") && (
            <button type="button" className="confirm-ok soft" disabled={busy} onClick={() => void recheck()}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
              {snap.phase === "error" ? "Retry" : "Check again"}
            </button>
          )}
          {snap.phase === "available" && (
            <button type="button" className="confirm-ok" disabled={busy} onClick={() => void install()}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
              Download & install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
