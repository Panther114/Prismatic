import {useEffect, useMemo, useState, type ComponentType, type DragEvent} from "react";
import {
  Check, Clapperboard, Download, GripVertical, LoaderCircle, Pencil, Play, Plus, Share2, Shuffle, Trash2, X,
} from "lucide-react";
import type {Playlist, Track} from "../types";
import {PlaylistCover} from "./PlaylistCover";
import {SHARE_MAX_DURATION_SEC, SHARE_MAX_TRACKS, validateShareLimits} from "../lib/playlistShare";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

export const toggleTrackMembership = (trackIds: string[], trackId: string) =>
  trackIds.includes(trackId) ? trackIds.filter((id) => id !== trackId) : [...trackIds, trackId];

export type PlaylistViewProps = {
  playlists: Playlist[];
  tracks: Track[];
  TrackCover: ComponentType<{track: Track}>;
  onCreate: (name: string, trackIds: string[]) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string, name: string) => void;
  onUpdateTracks: (id: string, trackIds: string[]) => Promise<void>;
  onPlay: (playlist: Playlist, shuffle: boolean) => void;
  onExport?: (playlist: Playlist) => void;
  onShare?: (playlist: Playlist) => void;
  onRedeemShare?: (code: string) => Promise<void>;
  shareBusy?: boolean;
  shareStatus?: string;
  exporting?: boolean;
  busy?: boolean;
  createRequest?: number;
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
  onShare,
  onRedeemShare,
  shareBusy,
  shareStatus,
  exporting,
  busy,
  createRequest = 0,
}: PlaylistViewProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editPlaylist, setEditPlaylist] = useState<Playlist | null>(null);
  const [editName, setEditName] = useState("");
  const [editIds, setEditIds] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemError, setRedeemError] = useState("");
  const byId = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);

  const durationOf = (playlist: Playlist) =>
    playlist.trackIds.reduce((sum, id) => sum + (byId.get(id)?.duration || 0), 0);

  const openCreate = () => {
    setEditPlaylist(null);
    setEditName("New playlist");
    setEditIds([]);
    setEditorOpen(true);
  };

  const openEdit = (playlist: Playlist) => {
    setEditPlaylist(playlist);
    setEditName(playlist.name);
    setEditIds([...playlist.trackIds]);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditPlaylist(null);
    setDragId(null);
  };

  const saveEditor = async () => {
    setSavingEdit(true);
    try {
      if (editPlaylist) {
        if (editName.trim() && editName.trim() !== editPlaylist.name) {
          await onRename(editPlaylist.id, editName.trim());
        }
        await onUpdateTracks(editPlaylist.id, editIds);
      } else {
        await onCreate(editName, editIds);
      }
      closeEditor();
    } finally {
      setSavingEdit(false);
    }
  };

  useEffect(() => {
    if (createRequest > 0) openCreate();
  }, [createRequest]);

  const outIds = useMemo(() => {
    const included = new Set(editIds);
    return tracks.filter((track) => !included.has(track.id)).map((track) => track.id);
  }, [tracks, editIds]);

  const startReorder = (id: string) => (event: DragEvent) => {
    setDragId(id);
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  };

  const reorderBefore = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setEditIds((current) => {
      const next = current.filter((id) => id !== dragId);
      const index = next.indexOf(targetId);
      next.splice(index < 0 ? next.length : index, 0, dragId);
      return next;
    });
    setDragId(null);
  };

  const shareDisabledReason = (playlist: Playlist) => {
    const list = playlist.trackIds.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));
    const check = validateShareLimits(list);
    if (!check.ok) return check.error;
    return "";
  };

  const submitRedeem = async () => {
    if (!onRedeemShare) return;
    setRedeemError("");
    try {
      await onRedeemShare(redeemCode.trim());
      setRedeemOpen(false);
      setRedeemCode("");
    } catch (cause) {
      setRedeemError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="utility-view playlist-view">
      <div className="utility-heading row">
        <div>
          <span>Playlists</span>
          <h1>Your sets.</h1>
          <p>Play, shuffle, share, export, or edit a set. Shares expire in 24h · max {SHARE_MAX_TRACKS} tracks · under {Math.floor(SHARE_MAX_DURATION_SEC / 60)} min.</p>
        </div>
        <div className="playlist-heading-actions">
          {onRedeemShare ? (
            <button type="button" className="secondary-button" disabled={busy || shareBusy} onClick={() => { setRedeemOpen(true); setRedeemError(""); }}>
              <Download size={14} />Import code
            </button>
          ) : null}
          <button type="button" className="secondary-button" disabled={busy} onClick={openCreate}>
            <Plus size={14} />Create playlist
          </button>
        </div>
      </div>

      {shareStatus ? <p className="playlist-share-status" role="status">{shareStatus}</p> : null}

      <div className="playlist-table custom-scroll">
        {playlists.map((playlist) => {
          const shareBlock = shareDisabledReason(playlist);
          return (
          <div key={playlist.id} className="playlist-table-row">
            <PlaylistCover trackIds={playlist.trackIds} tracksById={byId} size={30} />
            <div className="track-copy">
              <strong>{playlist.name}</strong>
              <small>{playlist.trackIds.length} tracks · {formatTime(durationOf(playlist))}</small>
            </div>
            <div className="playlist-row-actions dense">
              <button type="button" className="icon-btn" disabled={!playlist.trackIds.length} onClick={() => onPlay(playlist, false)} title="Play" aria-label={`Play ${playlist.name}`}>
                <Play size={13} fill="currentColor" />
              </button>
              <button type="button" className="icon-btn" disabled={!playlist.trackIds.length} onClick={() => onPlay(playlist, true)} title="Shuffle" aria-label={`Shuffle ${playlist.name}`}>
                <Shuffle size={13} />
              </button>
              {onShare ? (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={!playlist.trackIds.length || shareBusy || Boolean(shareBlock)}
                  onClick={() => onShare(playlist)}
                  title={shareBlock || "Share (1-day code)"}
                  aria-label={`Share ${playlist.name}`}
                >
                  {shareBusy ? <LoaderCircle className="spin" size={13} /> : <Share2 size={13} />}
                </button>
              ) : null}
              {onExport ? (
                <button type="button" className="icon-btn" disabled={!playlist.trackIds.length || exporting} onClick={() => onExport(playlist)} title="Export" aria-label={`Export ${playlist.name}`}>
                  {exporting ? <LoaderCircle className="spin" size={13} /> : <Clapperboard size={13} />}
                </button>
              ) : null}
              <button type="button" className="icon-btn" onClick={() => openEdit(playlist)} title="Edit" aria-label={`Edit ${playlist.name}`}>
                <Pencil size={13} />
              </button>
              <button type="button" className="icon-btn danger" onClick={() => onDelete(playlist.id, playlist.name)} title="Delete" aria-label={`Delete ${playlist.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          );
        })}
        {!playlists.length ? <p className="empty-library">No playlists yet. Create one and select its tracks.</p> : null}
      </div>

      {redeemOpen ? (
        <div className="confirm-overlay" role="presentation" onClick={() => !shareBusy && setRedeemOpen(false)}>
          <div
            className="confirm-dialog playlist-share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="playlist-redeem-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-dialog-head">
              <h2 id="playlist-redeem-title">Import shared playlist</h2>
              <button type="button" className="confirm-close" disabled={shareBusy} onClick={() => setRedeemOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <p className="save-hint">Enter the 4-digit code. Tracks download one-by-one (original quality), join your library, and the playlist is forged automatically.</p>
            <label className="playlist-edit-name">
              Code
              <input
                value={redeemCode}
                onChange={(event) => setRedeemCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="0000"
                maxLength={4}
                disabled={shareBusy}
              />
            </label>
            {redeemError ? <p className="playlist-share-error">{redeemError}</p> : null}
            {shareStatus ? <p className="playlist-share-status">{shareStatus}</p> : null}
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" disabled={shareBusy} onClick={() => setRedeemOpen(false)}>Cancel</button>
              <button type="button" className="confirm-ok" disabled={shareBusy || redeemCode.length !== 4} onClick={() => void submitRedeem()}>
                {shareBusy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
                Import
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editorOpen ? (
        <div className="confirm-overlay playlist-edit-overlay" role="presentation" onClick={closeEditor}>
          <div
            className="confirm-dialog playlist-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="playlist-edit-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-dialog-head">
              <h2 id="playlist-edit-title">{editPlaylist ? "Edit playlist" : "Create playlist"}</h2>
              <button type="button" className="confirm-close" onClick={closeEditor} aria-label="Close"><X size={16} /></button>
            </div>
            <label className="playlist-edit-name">
              Name
              <input value={editName} onChange={(event) => setEditName(event.target.value)} />
            </label>
            <p className="save-hint">Click a track to move it between columns. Drag tracks in the right column to change their order.</p>
            <div className="playlist-edit-columns">
              <div className="playlist-edit-col">
                <div className="section-label">Library (not in set)</div>
                <div className="playlist-edit-list custom-scroll">
                  {outIds.map((id) => {
                    const track = byId.get(id);
                    if (!track) return null;
                    return (
                      <button type="button" key={id} className="playlist-edit-item" onClick={() => setEditIds((current) => toggleTrackMembership(current, id))}>
                        <Plus size={12} className="drag-handle" />
                        <TrackCover track={track} />
                        <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                        <time className="playlist-edit-duration">{formatTime(track.duration)}</time>
                      </button>
                    );
                  })}
                  {!outIds.length ? <p className="empty-library">All tracks are in this playlist.</p> : null}
                </div>
              </div>
              <div className="playlist-edit-col">
                <div className="section-label">In playlist ({editIds.length})</div>
                <div className="playlist-edit-list custom-scroll">
                  {editIds.map((id) => {
                    const track = byId.get(id);
                    if (!track) {
                      return (
                        <div key={id} className="playlist-edit-item missing">
                          <span className="track-copy"><strong>Missing</strong><small>{id}</small></span>
                          <button type="button" className="icon-btn" onClick={() => setEditIds((current) => current.filter((trackId) => trackId !== id))}><X size={12} /></button>
                        </div>
                      );
                    }
                    return (
                      <button
                        type="button"
                        key={id}
                        className="playlist-edit-item"
                        draggable
                        onDragStart={startReorder(id)}
                        onDragEnd={() => setDragId(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          reorderBefore(id);
                        }}
                        onClick={() => setEditIds((current) => toggleTrackMembership(current, id))}
                      >
                        <GripVertical size={12} className="drag-handle" />
                        <TrackCover track={track} />
                        <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                        <time className="playlist-edit-duration">{formatTime(track.duration)}</time>
                      </button>
                    );
                  })}
                  {!editIds.length ? <p className="empty-library">Select tracks from the left.</p> : null}
                </div>
              </div>
            </div>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={closeEditor}>Cancel</button>
              <button type="button" className="confirm-ok" disabled={savingEdit || !editName.trim()} onClick={() => void saveEditor()}>
                {savingEdit ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
                {editPlaylist ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
