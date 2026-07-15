import {useMemo, useState, type ComponentType} from "react";
import {
  ChevronDown, ChevronUp, Clapperboard, ListMusic, LoaderCircle, Play, Plus, Shuffle, Trash2, Pencil, Check, X,
} from "lucide-react";
import type {Playlist, Track} from "../types";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

export type PlaylistViewProps = {
  playlists: Playlist[];
  tracks: Track[];
  selectedTrackId: string;
  TrackCover: ComponentType<{track: Track}>;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string, name: string) => void;
  onUpdateTracks: (id: string, trackIds: string[]) => Promise<void>;
  onPlay: (playlist: Playlist, shuffle: boolean) => void;
  onSelectTrack: (trackId: string) => void;
  /** Export all tracks in order as one merged visualizer video. */
  onExport?: (playlist: Playlist) => void;
  exporting?: boolean;
  busy?: boolean;
};

export function PlaylistView({
  playlists,
  tracks,
  selectedTrackId,
  TrackCover,
  onCreate,
  onRename,
  onDelete,
  onUpdateTracks,
  onPlay,
  onSelectTrack,
  onExport,
  exporting,
  busy,
}: PlaylistViewProps) {
  const [activeId, setActiveId] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("New playlist");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [pickIds, setPickIds] = useState<Set<string>>(new Set());

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const active = playlists.find((p) => p.id === (activeId || playlists[0]?.id)) || null;

  const durationOf = (pl: Playlist) =>
    pl.trackIds.reduce((sum, id) => sum + (byId.get(id)?.duration || 0), 0);

  const create = async () => {
    setCreating(true);
    try {
      await onCreate(newName);
      setNewName("New playlist");
    } finally {
      setCreating(false);
    }
  };

  const commitRename = async () => {
    if (!renamingId) return;
    await onRename(renamingId, renameValue);
    setRenamingId("");
  };

  const moveTrack = async (pl: Playlist, index: number, delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= pl.trackIds.length) return;
    const trackIds = [...pl.trackIds];
    const [item] = trackIds.splice(index, 1);
    trackIds.splice(next, 0, item);
    await onUpdateTracks(pl.id, trackIds);
  };

  const removeFromPlaylist = async (pl: Playlist, trackId: string) => {
    await onUpdateTracks(pl.id, pl.trackIds.filter((id) => id !== trackId));
  };

  const addPicked = async () => {
    if (!active || !pickIds.size) return;
    setAdding(true);
    try {
      const set = new Set(active.trackIds);
      const merged = [...active.trackIds];
      for (const id of pickIds) {
        if (!set.has(id)) {
          set.add(id);
          merged.push(id);
        }
      }
      await onUpdateTracks(active.id, merged);
      setPickIds(new Set());
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="utility-view playlist-view">
      <div className="utility-heading row">
        <div>
          <span>Playlists</span>
          <h1>Your sets.</h1>
          <p>Create playlists, queue them, shuffle, and play through the transport.</p>
        </div>
        <div className="playlist-create-row">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New playlist name"
            onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          />
          <button type="button" className="secondary-button" disabled={creating || busy} onClick={() => void create()}>
            {creating ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
            Create
          </button>
        </div>
      </div>

      <div className="playlist-layout">
        <div className="playlist-sidebar-list">
          {playlists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              className={`playlist-list-item ${active?.id === pl.id ? "selected" : ""}`}
              onClick={() => setActiveId(pl.id)}
            >
              <ListMusic size={14} />
              <span className="track-copy">
                <strong>{pl.name}</strong>
                <small>{pl.trackIds.length} tracks · {formatTime(durationOf(pl))}</small>
              </span>
            </button>
          ))}
          {!playlists.length && <p className="empty-library">No playlists yet. Create one above.</p>}
        </div>

        <div className="playlist-detail">
          {active ? (
            <>
              <div className="playlist-detail-head">
                {renamingId === active.id ? (
                  <div className="playlist-rename-row">
                    <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") setRenamingId("");
                    }} />
                    <button type="button" className="icon-btn" onClick={() => void commitRename()} aria-label="Save name"><Check size={14} /></button>
                    <button type="button" className="icon-btn" onClick={() => setRenamingId("")} aria-label="Cancel rename"><X size={14} /></button>
                  </div>
                ) : (
                  <h2>{active.name}</h2>
                )}
                <div className="playlist-actions">
                  <button type="button" className="secondary-button" onClick={() => onPlay(active, false)} disabled={!active.trackIds.length}>
                    <Play size={14} fill="currentColor" /> Play
                  </button>
                  <button type="button" className="secondary-button" onClick={() => onPlay(active, true)} disabled={!active.trackIds.length}>
                    <Shuffle size={14} /> Shuffle
                  </button>
                  {onExport && (
                    <button
                      type="button"
                      className="secondary-button"
                      title="Export entire playlist as one video (tracks in order, merged)"
                      onClick={() => onExport(active)}
                      disabled={!active.trackIds.length || exporting || busy}
                    >
                      {exporting ? <LoaderCircle className="spin" size={14} /> : <Clapperboard size={14} />}
                      {exporting ? "Exporting…" : "Export all"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    title="Rename"
                    onClick={() => { setRenamingId(active.id); setRenameValue(active.name); }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="icon-btn danger" title="Delete playlist" onClick={() => onDelete(active.id, active.name)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="playlist-add-block">
                <div className="section-label">Add from library</div>
                <div className="playlist-picker">
                  {tracks.map((track) => {
                    const checked = pickIds.has(track.id) || active.trackIds.includes(track.id);
                    const already = active.trackIds.includes(track.id);
                    return (
                      <label key={track.id} className={`playlist-pick-row ${already ? "already" : ""}`}>
                        <input
                          type="checkbox"
                          disabled={already}
                          checked={checked}
                          onChange={() => {
                            if (already) return;
                            setPickIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(track.id)) next.delete(track.id);
                              else next.add(track.id);
                              return next;
                            });
                          }}
                        />
                        <TrackCover track={track} />
                        <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                      </label>
                    );
                  })}
                  {!tracks.length && <p className="empty-library">Import tracks first.</p>}
                </div>
                <button type="button" className="secondary-button" disabled={!pickIds.size || adding} onClick={() => void addPicked()}>
                  {adding ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
                  Add selected
                </button>
              </div>

              <div className="playlist-tracks">
                {active.trackIds.map((id, index) => {
                  const track = byId.get(id);
                  if (!track) {
                    return (
                      <div key={id} className="library-card missing">
                        <span className="track-copy"><strong>Missing track</strong><small>{id}</small></span>
                        <button type="button" className="track-remove" onClick={() => void removeFromPlaylist(active, id)} aria-label="Remove missing">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={id} className={`library-card ${selectedTrackId === id ? "selected" : ""}`}>
                      <button type="button" className="library-card-main" onClick={() => onSelectTrack(id)} onDoubleClick={() => onPlay({...active, trackIds: [id, ...active.trackIds.filter((t) => t !== id)]}, false)}>
                        <TrackCover track={track} />
                        <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                        <time className="mono">{formatTime(track.duration)}</time>
                      </button>
                      <div className="playlist-row-actions">
                        <button type="button" className="icon-btn" disabled={index === 0} onClick={() => void moveTrack(active, index, -1)} aria-label="Move up"><ChevronUp size={14} /></button>
                        <button type="button" className="icon-btn" disabled={index === active.trackIds.length - 1} onClick={() => void moveTrack(active, index, 1)} aria-label="Move down"><ChevronDown size={14} /></button>
                        <button type="button" className="track-remove" onClick={() => void removeFromPlaylist(active, id)} aria-label={`Remove ${track.title}`}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  );
                })}
                {!active.trackIds.length && <p className="empty-library">This playlist is empty. Add tracks from the library.</p>}
              </div>
            </>
          ) : (
            <p className="empty-library">Select or create a playlist.</p>
          )}
        </div>
      </div>
    </div>
  );
}
