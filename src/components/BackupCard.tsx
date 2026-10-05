import {Archive, FileSpreadsheet, ListMusic, LoaderCircle, RotateCcw, Square} from "lucide-react";
import {useState} from "react";
import {
  cancelLibraryBackup, exportLibraryBackup, exportLibraryList, importLibraryBackup,
  summarizeExport, summarizeImport,
} from "../lib/libraryBackup";

type Props = {
  /** Reload tracks, playlists and prefs after a restore. */
  onRestored: () => Promise<void>;
  onError: (message: string) => void;
};

function Check({checked, onChange, children}: {checked: boolean; onChange: (value: boolean) => void; children: string}) {
  return (
    <label className="backup-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function BackupCard({onRestored, onError}: Props) {
  const [busy, setBusy] = useState<"" | "export" | "import" | "list">("");
  const [message, setMessage] = useState("");
  const [ratio, setRatio] = useState(0);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [includePlaylists, setIncludePlaylists] = useState(true);
  const [includeSettings, setIncludeSettings] = useState(true);

  const run = async (kind: "export" | "import" | "list", action: () => Promise<string>) => {
    setBusy(kind);
    setRatio(0);
    setMessage("");
    try {
      setMessage(await action());
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (/cancel/i.test(text)) setMessage("");
      else onError(text);
    } finally {
      setBusy("");
      setRatio(0);
    }
  };

  const progress = (text: string, value: number) => {
    setMessage(text);
    setRatio(value);
  };

  return (
    <section className="watch-panel backup-card" aria-label="Backup and restore">
      <div className="watch-panel-head">
        <Archive size={15} />
        <div>
          <strong>Backup &amp; restore</strong>
          <span>One zip with your whole library: audio, playlists, title edits and settings. Restoring merges and skips audio you already have.</span>
        </div>
      </div>
      <div className="backup-options">
        <Check checked={includeAudio} onChange={setIncludeAudio}>Audio files</Check>
        <Check checked={includePlaylists} onChange={setIncludePlaylists}>Playlists</Check>
        <Check checked={includeSettings} onChange={setIncludeSettings}>Settings</Check>
      </div>
      <div className="backup-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={Boolean(busy)}
          onClick={() => void run("export", async () => summarizeExport(
            await exportLibraryBackup({includeAudio, includePlaylists, includeSettings}, progress),
          ))}
        >
          {busy === "export" ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}
          Export full backup…
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={Boolean(busy)}
          onClick={() => void run("import", async () => {
            const result = await importLibraryBackup({restorePlaylists: includePlaylists, restoreSettings: includeSettings}, progress);
            await onRestored();
            return summarizeImport(result);
          })}
        >
          {busy === "import" ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
          Restore from backup…
        </button>
        {(busy === "export" || busy === "import") && (
          <button type="button" className="cancel-button" onClick={() => void cancelLibraryBackup()}>
            <Square size={11} fill="currentColor" /> Cancel
          </button>
        )}
      </div>
      {busy && busy !== "list" && (
        <div className="status-progress backup-progress"><i style={{transform: `scaleX(${Math.max(0.02, ratio)})`}} /></div>
      )}
      {message && <p className="save-hint backup-message" role="status">{message}</p>}
      <div className="backup-actions backup-lists">
        <span className="save-hint mono">Portable lists</span>
        <button
          type="button"
          className="secondary-button compact"
          disabled={Boolean(busy)}
          onClick={() => void run("list", async () => `Exported ${await exportLibraryList("csv")} tracks to CSV.`)}
        >
          <FileSpreadsheet size={12} /> CSV
        </button>
        <button
          type="button"
          className="secondary-button compact"
          disabled={Boolean(busy)}
          onClick={() => void run("list", async () => `Exported ${await exportLibraryList("m3u8")} tracks to M3U8.`)}
        >
          <ListMusic size={12} /> M3U8
        </button>
      </div>
    </section>
  );
}
