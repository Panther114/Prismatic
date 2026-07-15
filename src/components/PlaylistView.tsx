import {useMemo, useState, type ComponentType, type DragEvent} from "react";
import {
  Clapperboard, GripVertical, LoaderCircle, Pencil, Play, Plus, Shuffle, Trash2, X, Check,
} from "lucide-react";
import type {Playlist, Track} from "../types";
import {PlaylistCover} from "./PlaylistCover";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

export type PlaylistViewProps = {
  playlists: Playlist[];
  tracks: Track[];
  TrackCover: ComponentType<{track: Track}>;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string, name: string) => void;
  onUpdateTracks: (id: string, trackIds: string[]) => Promise<void>;
  onPlay: (playlist: Playlist, shuffle: boolean) => void;
  onExport?: (playlist: Playlist) => void;
  exporting?: boolean;
  busy?: boolean;
};

export function PlaylistView({
  playlists,
  tracks,
  TrackCover,
  onCreate,
  onRename,
  onDelete,
  onUpdateTracks,
  onPlay,
  onExport,
  exporting,
  busy,
}: PlaylistViewProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("New playlist");
  const [editPlaylist, setEditPlaylist] = useState<Playlist | null>(null);
  const [editName, setEditName] = useState("");
  const [editIds, setEditIds] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<"in" | "out" | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

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

  const openEdit = (pl: Playlist) => {
    setEditPlaylist(pl);
    setEditName(pl.name);
    setEditIds([...pl.trackIds]);
  };

  const closeEdit = () => {
    setEditPlaylist(null);
    setDragId(null);
    setDragFrom(null);
  };

  const saveEdit = async () => {
    if (!editPlaylist) return;
    setSavingEdit(true);
    try {
      if (editName.trim() && editName.trim() !== editPlaylist.name) {
        await onRename(editPlaylist.id, editName.trim());
      }
      await onUpdateTracks(editPlaylist.id, editIds);
      closeEdit();
    } finally {
      setSavingEdit(false);
    }
  };

  const outIds = useMemo(() => {
    const inSet = new Set(editIds);
    return tracks.filter((t) => !inSet.has(t.id)).map((t) => t.id);
  }, [tracks, editIds]);

  const onDragStart = (id: string, from: "in" | "out") => (event: DragEvent) => {
    setDragId(id);
    setDragFrom(from);
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  };

  const dropOnIn = (event: DragEvent) => {
    event.preventDefault();
    const id = dragId || event.dataTransfer.getData("text/plain");
    if (!id) return;
    setEditIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setDragId(null);
    setDragFrom(null);
  };

  const dropOnOut = (event: DragEvent) => {
    event.preventDefault();
    const id = dragId || event.dataTransfer.getData("text/plain");
    if (!id) return;
    setEditIds((prev) => prev.filter((x) => x !== id));
    setDragId(null);
    setDragFrom(null);
  };

  const reorderIn = (targetId: string) => {
    if (!dragId || dragFrom !== "in" || dragId === targetId) return;
    setEditIds((prev) => {
      const next = prev.filter((x) => x !== dragId);
      const at = next.indexOf(targetId);
      if (at < 0) return [...next, dragId];
      next.splice(at, 0, dragId);
      return next;
    });
    setDragId(null);
    setDragFrom(null);
  };

  return (
    <div className="utility-view playlist-view">
      <div className="utility-heading row">
        <div>
          <span>Playlists</span>
          <h1>Your sets.</h1>
          <p>Play, shuffle, export, or edit track membership in a two-pane editor.</p>
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

      <div className="playlist-table">
        {playlists.map((pl) => (
          <div key={pl.id} className="playlist-table-row">
            <PlaylistCover trackIds={pl.trackIds} tracksById={byId} size={48} />
            <div className="track-copy">
              <strong>{pl.name}</strong>
              <small>{pl.trackIds.length} tracks · {formatTime(durationOf(pl))}</small>
            </div>
            <div className="playlist-row-actions dense">
              <button type="button" className="secondary-button compact" disabled={!pl.trackIds.length} onClick={() => onPlay(pl, false)} title="Play">
                <Play size={13} fill="currentColor" /> Play
              </button>
              <button type="button" className="secondary-button compact" disabled={!pl.trackIds.length} onClick={() => onPlay(pl, true)} title="Shuffle play">
                <Shuffle size={13} /> Shuffle
              </button>
              {onExport && (
                <button type="button" className="secondary-button compact" disabled={!pl.trackIds.length || exporting} onClick={() => onExport(pl)} title="Export all">
                  {exporting ? <LoaderCircle className="spin" size={13} /> : <Clapperboard size={13} />}
                  Export
                </button>
              )}
              <button type="button" className="secondary-button compact" onClick={() => openEdit(pl)} title="Edit">
                <Pencil size={13} /> Edit
              </button>
              <button type="button" className="icon-btn danger" onClick={() => onDelete(pl.id, pl.name)} title="Delete" aria-label={`Delete ${pl.name}`}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {!playlists.length && (
          <p className="empty-library">No playlists yet. Create one above, then edit to add tracks.</p>
        )}
      </div>

      {editPlaylist && (
        <div className="confirm-overlay playlist-edit-overlay" role="presentation" onClick={closeEdit}>
          <div
            className="confirm-dialog playlist-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="playlist-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-dialog-head">
              <h2 id="playlist-edit-title">Edit playlist</h2>
              <button type="button" className="confirm-close" onClick={closeEdit} aria-label="Close"><X size={16} /></button>
            </div>
            <label className="playlist-edit-name">
              Name
              <input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <p className="save-hint">Drag tracks between columns. Right = in playlist (order top → bottom).</p>
            <div className="playlist-edit-columns">
              <div
                className={`playlist-edit-col ${dragFrom === "out" ? "drag-source" : ""}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={dropOnOut}
              >
                <div className="section-label">Library (not in set)</div>
                <div className="playlist-edit-list custom-scroll">
                  {outIds.map((id) => {
                    const track = byId.get(id);
                    if (!track) return null;
                    return (
                      <div
                        key={id}
                        className="playlist-edit-item"
                        draggable
                        onDragStart={onDragStart(id, "out")}
                        onDoubleClick={() => setEditIds((prev) => [...prev, id])}
                      >
                        <GripVertical size={12} className="drag-handle" />
                        <TrackCover track={track} />
                        <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                      </div>
                    );
                  })}
                  {!outIds.length && <p className="empty-library">All tracks are in this playlist.</p>}
                </div>
              </div>
              <div
                className={`playlist-edit-col ${dragFrom === "in" ? "drag-source" : ""}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={dropOnIn}
              >
                <div className="section-label">In playlist ({editIds.length})</div>
                <div className="playlist-edit-list custom-scroll">
                  {editIds.map((id) => {
                    const track = byId.get(id);
                    if (!track) {
                      return (
                        <div key={id} className="playlist-edit-item missing">
                          <span className="track-copy"><strong>Missing</strong><small>{id}</small></span>
                          <button type="button" className="icon-btn" onClick={() => setEditIds((p) => p.filter((x) => x !== id))}><X size={12} /></button>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={id}
                        className="playlist-edit-item"
                        draggable
                        onDragStart={onDragStart(id, "in")}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); reorderIn(id); }}
                        onDoubleClick={() => setEditIds((p) => p.filter((x) => x !== id))}
                      >
                        <GripVertical size={12} className="drag-handle" />
                        <TrackCover track={track} />
                        <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                      </div>
                    );
                  })}
                  {!editIds.length && <p className="empty-library">Drop tracks here from the left.</p>}
                </div>
              </div>
            </div>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={closeEdit}>Cancel</button>
              <button type="button" className="confirm-ok" disabled={savingEdit} onClick={() => void saveEdit()}>
                {savingEdit ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
