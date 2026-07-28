import {useEffect, useState} from "react";
import {Download, LoaderCircle, RefreshCw} from "lucide-react";
import {appUpdater, type UpdateSnapshot} from "../lib/appUpdater";

type Props = {
  onOpenDialog: () => void;
};

export function UpdateSettingsCard({onOpenDialog}: Props) {
  const [snap, setSnap] = useState<UpdateSnapshot>(() => appUpdater.getSnapshot());
  const [busy, setBusy] = useState(false);

  useEffect(() => appUpdater.subscribe(setSnap), []);

  if (!appUpdater.isDesktop()) {
    return (
      <section className="watch-panel update-settings-card">
        <div className="watch-panel-head">
          <RefreshCw size={15} />
          <div>
            <strong>Software updates</strong>
            <span>Desktop auto-update is available in the Windows/macOS app only.</span>
          </div>
        </div>
      </section>
    );
  }

  const statusText = (() => {
    switch (snap.phase) {
      case "checking":
        return "Checking…";
      case "available":
        return `Version ${snap.availableVersion} is ready`;
      case "downloading":
        return snap.progress.percent != null ? `Downloading… ${snap.progress.percent}%` : "Downloading…";
      case "installing":
        return "Installing…";
      case "ready":
        return "Restarting…";
      case "up-to-date":
        return "You're on the latest version";
      case "error":
        return snap.error || "Update check failed";
      default:
        return "Signed updates from GitHub Releases";
    }
  })();

  const check = async () => {
    setBusy(true);
    try {
      const next = await appUpdater.checkForUpdates({reason: "manual"});
      if (next.phase === "available" || next.phase === "error" || next.phase === "up-to-date") {
        onOpenDialog();
      }
    } finally {
      setBusy(false);
    }
  };

  const install = () => {
    onOpenDialog();
    void appUpdater.downloadAndInstall().catch(() => {
      onOpenDialog();
    });
  };

  return (
    <section className="watch-panel update-settings-card">
      <div className="watch-panel-head">
        <RefreshCw size={15} />
        <div>
          <strong>Software updates</strong>
          <span>
            Current <span className="mono">{snap.currentVersion || "—"}</span>
            {snap.availableVersion ? (
              <>
                {" · "}available <span className="mono">{snap.availableVersion}</span>
              </>
            ) : null}
            {" · "}
            {statusText}
          </span>
        </div>
      </div>
      <div className="watch-add-row update-settings-actions">
        <button type="button" className="secondary-button" disabled={busy || snap.phase === "downloading" || snap.phase === "installing"} onClick={() => void check()}>
          {busy || snap.phase === "checking" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          Check for updates
        </button>
        {snap.phase === "available" && (
          <button type="button" className="secondary-button" disabled={busy} onClick={install}>
            <Download size={14} />
            Install {snap.availableVersion}
          </button>
        )}
      </div>
    </section>
  );
}
