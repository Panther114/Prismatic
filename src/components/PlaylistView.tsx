import {memo, useDeferredValue, useEffect, useMemo, useState, type ComponentType, type CSSProperties, type DragEvent} from "react";
import {
  Archive, ArrowDown, ArrowLeft, ArrowUp, Check, Clapperboard, FileArchive, GripVertical, LoaderCircle, Pencil, Play, Plus, Search, Shuffle, Trash2, X,
} from "lucide-react";
import type {Playlist, Track} from "../types";
import {accentCss, useAccent} from "../lib/accent";
import {playlistCoverUrls} from "../lib/coverUtils";
import {toast} from "../lib/toast";
import {CustomSelect} from "./CustomSelect";
import {PlaylistCover} from "./PlaylistCover";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

/** Moves `fromId` so it takes the position `toId` currently has. */
export function moveTrackId(ids: string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

/** "3:42" under an hour, "2 hr 5 min" above, so long playlists stay readable. */
export function formatTotalDuration(seconds: number) {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (total < 3600) return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes === 60 ? `${hours + 1} hr` : `${hours} hr ${minutes} min`;
}

export const toggleTrackMembership = (trackIds: string[], trackId: string) =>
  trackIds.includes(trackId) ? trackIds.filter((id) => id !== trackId) : [...trackIds, trackId];

export type PlaylistSort = "order" | "title" | "artist" | "album" | "duration";
export type PlaylistSortDirection = "asc" | "desc";

export function filterPlaylistTracks(trackIds: string[], tracksById: Map<string, Track>, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return trackIds.flatMap((id, index) => {
    const track = tracksById.get(id);
    return track ? [{track, index}] : [];
  }).filter(({track}) =>
    !normalized
    || track.title.toLocaleLowerCase().includes(normalized)
    || track.artist.toLocaleLowerCase().includes(normalized)
    || track.album.toLocaleLowerCase().includes(normalized),
  );
}

export function sortPlaylistTracks(
  rows: ReturnType<typeof filterPlaylistTracks>,
  sort: PlaylistSort,
  direction: PlaylistSortDirection,
) {
  return [...rows].sort((a, b) => {
    if (sort === "order") return a.index - b.index;
    const aValue = sort === "duration" ? a.track.duration : a.track[sort].trim();
    const bValue = sort === "duration" ? b.track.duration : b.track[sort].trim();
    const aMissing = typeof aValue === "string" ? !aValue : !Number.isFinite(aValue);
    const bMissing = typeof bValue === "string" ? !bValue : !Number.isFinite(bValue);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    const result = typeof aValue === "number" && typeof bValue === "number"
      ? aValue - bValue
      : String(aValue).localeCompare(String(bValue), undefined, {numeric: true, sensitivity: "base"});
    return result === 0 ? a.index - b.index : direction === "asc" ? result : -result;
  }).map(({track}) => track);
}

export type PlaylistViewProps = {
  playlists: Playlist[];
  tracks: Track[];
  TrackCover: ComponentType<{track: Track}>;
  onCreate: (name: string, trackIds: string[]) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string, name: string) => void;
  onUpdateTracks: (id: string, trackIds: string[]) => Promise<void>;
  onPlay: (playlist: Playlist, shuffle: boolean) => void;
  onPlayTrack?: (playlist: Playlist, trackId: string) => void;
  onExport?: (playlist: Playlist) => void;
  onExportZip?: (playlist: Playlist) => void;
  onImportZip?: () => void;
  zipBusy?: boolean;
  zipStatus?: string;
  exporting?: boolean;
  busy?: boolean;
  createRequest?: number;
  /** Track currently loaded in the player, for the now-playing marker. */
  currentTrackId?: string;
  playing?: boolean;
};

/** Three bars animated with CSS only; frozen when audio is paused. */
function Equalizer({playing}: {playing: boolean}) {
  return <span className={`eq ${playing ? "on" : ""}`} aria-label={playing ? "Playing" : "Paused"}><i /><i /><i /></span>;
}

const PlaylistTile = memo(function PlaylistTile({playlist, byId, duration, onOpen, onPlay}: {
  playlist: Playlist;
  byId: Map<string, Track>;
  duration: number;
  onOpen: () => void;
  onPlay: (shuffle: boolean) => void;
}) {
  const firstCover = useMemo(() => playlistCoverUrls(playlist.trackIds, byId)[0], [playlist.trackIds, byId]);
  const accent = useAccent(firstCover, playlist.id);
  return (
    <div className="playlist-tile" style={{"--accent": accentCss(accent)} as CSSProperties}>
      <div className="playlist-tile-art">
        <button type="button" className="playlist-tile-open" onClick={onOpen} aria-label={`Open ${playlist.name}`}>
          <PlaylistCover trackIds={playlist.trackIds} tracksById={byId} size={40} className="tile-cover" />
        </button>
        <span className="tile-actions">
          <button type="button" className="icon-btn" disabled={!playlist.trackIds.length} onClick={() => onPlay(true)} title="Shuffle" aria-label={`Shuffle ${playlist.name}`}>
            <Shuffle size={14} />
          </button>
          <button type="button" className="icon-btn tile-play" disabled={!playlist.trackIds.length} onClick={() => onPlay(false)} title="Play" aria-label={`Play ${playlist.name}`}>
            <Play size={16} fill="currentColor" />
          </button>
        </span>
      </div>
      <button type="button" className="playlist-tile-copy" onClick={onOpen}>
        <strong>{playlist.name}</strong>
        <small>{playlist.trackIds.length} track{playlist.trackIds.length === 1 ? "" : "s"} · {formatTotalDuration(duration)}</small>
      </button>
    </div>
  );
});

export function PlaylistView({
  playlists,
  tracks,
  TrackCover,
  onCreate,
  onRename,
  onDelete,
  onUpdateTracks,
  onPlay,
  onPlayTrack,
  onExport,
  onExportZip,
  onImportZip,
  zipBusy,
  zipStatus,
  exporting,
  busy,
  createRequest = 0,
  currentTrackId,
  playing = false,
}: PlaylistViewProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editPlaylist, setEditPlaylist] = useState<Playlist | null>(null);
  const [editName, setEditName] = useState("");
  const [editIds, setEditIds] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [playlistSort, setPlaylistSort] = useState<PlaylistSort>("order");
  const [playlistSortDirection, setPlaylistSortDirection] = useState<PlaylistSortDirection>("asc");
  const [rowDragId, setRowDragId] = useState<string | null>(null);
  const [rowDropId, setRowDropId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const openPlaylist = openId ? playlists.find((playlist) => playlist.id === openId) || null : null;
  const deferredPlaylistQuery = useDeferredValue(playlistQuery.trim().toLocaleLowerCase());
  const playlistTracks = useMemo(() => {
    if (!openPlaylist) return [];
    const filtered = filterPlaylistTracks(openPlaylist.trackIds, byId, deferredPlaylistQuery);
    return sortPlaylistTracks(filtered, playlistSort, playlistSortDirection);
  }, [byId, deferredPlaylistQuery, openPlaylist, playlistSort, playlistSortDirection]);

  useEffect(() => {
    setPlaylistQuery("");
    setPlaylistSort("order");
    setPlaylistSortDirection("asc");
  }, [openId]);

  const heroCover = useMemo(
    () => (openPlaylist ? playlistCoverUrls(openPlaylist.trackIds, byId)[0] : undefined),
    [openPlaylist, byId],
  );
  const heroAccent = useAccent(heroCover, openPlaylist?.id ?? "none");
  // Reordering by drag only makes sense when the list shows true playlist order.
  const canReorder = playlistSort === "order" && !deferredPlaylistQuery;

  const removeFromPlaylist = async (playlist: Playlist, trackId: string) => {
    const previous = playlist.trackIds;
    const title = byId.get(trackId)?.title ?? "Track";
    await onUpdateTracks(playlist.id, previous.filter((id) => id !== trackId));
    toast.info(`Removed “${title}” from ${playlist.name}.`, {
      actionLabel: "Undo",
      onAction: () => void onUpdateTracks(playlist.id, previous),
    });
  };

  const dropRow = async (playlist: Playlist, targetId: string) => {
    const dragged = rowDragId;
    setRowDragId(null);
    setRowDropId(null);
    if (!dragged || dragged === targetId) return;
    const next = moveTrackId(playlist.trackIds, dragged, targetId);
    if (next !== playlist.trackIds) await onUpdateTracks(playlist.id, next);
  };

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

  return (
    <div className="utility-view playlist-view">
      <div className="utility-heading row">
        <div>
          <span>Playlists</span>
          <h1>Your sets.</h1>
          <p>Play, shuffle, export zip, or edit a set. Zip packs audio files for offline transfer.</p>
        </div>
        <div className="playlist-heading-actions">
          {onImportZip ? (
            <button type="button" className="secondary-button" disabled={busy || zipBusy} onClick={onImportZip}>
              <FileArchive size={14} />Import zip
            </button>
          ) : null}
          <button type="button" className="secondary-button" disabled={busy} onClick={openCreate}>
            <Plus size={14} />Create playlist
          </button>
        </div>
      </div>

      {zipStatus ? <p className="playlist-share-status" role="status">{zipStatus}</p> : null}

      {openPlaylist ? (
        <div className="playlist-detail-view custom-scroll" style={{"--accent": accentCss(heroAccent)} as CSSProperties}>
          <button type="button" className="back-link" onClick={() => setOpenId(null)}>
            <ArrowLeft size={15} />View all playlists
          </button>
          <header className="pl-hero">
            <PlaylistCover trackIds={openPlaylist.trackIds} tracksById={byId} size={168} className="pl-hero-cover" />
            <div className="pl-hero-copy">
              <span className="eyebrow">Playlist</span>
              <h2>{openPlaylist.name}</h2>
              <p>{openPlaylist.trackIds.length} track{openPlaylist.trackIds.length === 1 ? "" : "s"} · {formatTotalDuration(durationOf(openPlaylist))}</p>
              <div className="pl-hero-actions">
                <button type="button" className="pl-play" disabled={!openPlaylist.trackIds.length} onClick={() => onPlay(openPlaylist, false)}>
                  <Play size={15} fill="currentColor" />Play
                </button>
                <button type="button" className="pl-ghost" disabled={!openPlaylist.trackIds.length} onClick={() => onPlay(openPlaylist, true)}>
                  <Shuffle size={14} />Shuffle
                </button>
                <span className="pl-hero-tools">
                  {onExportZip ? (
                    <button type="button" className="icon-btn" disabled={!openPlaylist.trackIds.length || zipBusy} onClick={() => onExportZip(openPlaylist)} title="Export as zip" aria-label={`Export ${openPlaylist.name} as zip`}>
                      {zipBusy ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}
                    </button>
                  ) : null}
                  {onExport ? (
                    <button type="button" className="icon-btn" disabled={!openPlaylist.trackIds.length || exporting} onClick={() => onExport(openPlaylist)} title="Export video" aria-label={`Export video ${openPlaylist.name}`}>
                      {exporting ? <LoaderCircle className="spin" size={14} /> : <Clapperboard size={14} />}
                    </button>
                  ) : null}
                  <button type="button" className="icon-btn" onClick={() => openEdit(openPlaylist)} title="Edit" aria-label={`Edit ${openPlaylist.name}`}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="icon-btn danger" onClick={() => onDelete(openPlaylist.id, openPlaylist.name)} title="Delete" aria-label={`Delete ${openPlaylist.name}`}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            </div>
          </header>
          <div className="playlist-detail-controls pl-sticky">
            <label className="library-search-v2 playlist-search-v2">
              <Search size={14} aria-hidden="true" />
              <input
                value={playlistQuery}
                onChange={(event) => setPlaylistQuery(event.target.value)}
                placeholder="Search this playlist"
                aria-label="Search this playlist"
              />
              {playlistQuery ? (
                <button type="button" onClick={() => setPlaylistQuery("")} aria-label="Clear playlist search"><X size={14} /></button>
              ) : null}
            </label>
            <CustomSelect
              className="library-sort-select playlist-sort-select"
              ariaLabel="Sort playlist tracks"
              value={playlistSort}
              onChange={(value) => {
                setPlaylistSort(value as PlaylistSort);
                setPlaylistSortDirection("asc");
              }}
              options={[
                {value: "order", label: "Playlist order"},
                {value: "title", label: "Title"},
                {value: "artist", label: "Artist"},
                {value: "album", label: "Album"},
                {value: "duration", label: "Duration"},
              ]}
            />
            <button
              type="button"
              className="playlist-sort-direction"
              disabled={playlistSort === "order"}
              onClick={() => setPlaylistSortDirection((current) => current === "asc" ? "desc" : "asc")}
              aria-label={`Sort ${playlistSortDirection === "asc" ? "descending" : "ascending"}`}
              title={playlistSort === "order" ? "Choose a sort field to change order" : `Sort ${playlistSortDirection === "asc" ? "descending" : "ascending"}`}
            >
              {playlistSortDirection === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              <span>{playlistSortDirection === "asc" ? "Ascending" : "Descending"}</span>
            </button>
            <span className="playlist-result-count" aria-live="polite">
              {deferredPlaylistQuery ? `${playlistTracks.length} of ${openPlaylist.trackIds.length} tracks` : `${playlistTracks.length} tracks`}
            </span>
          </div>
          <div className="pl-columns" aria-hidden="true">
            <span>#</span>
            <span>Song</span>
            <span className="song-album">Album</span>
            <span>Length</span>
            <span />
          </div>
          <div className="pl-list">
            {playlistTracks.map((track, position) => {
              const id = track.id;
              const isCurrent = id === currentTrackId;
              return (
                <div
                  key={id}
                  className={`pl-row ${isCurrent ? "current" : ""} ${rowDropId === id && rowDragId !== id ? "drop-target" : ""} ${rowDragId === id ? "dragging" : ""}`}
                  draggable={canReorder}
                  onDragStart={(event) => {
                    setRowDragId(id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", id);
                  }}
                  onDragOver={(event) => {
                    if (!rowDragId) return;
                    event.preventDefault();
                    if (rowDropId !== id) setRowDropId(id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void dropRow(openPlaylist, id);
                  }}
                  onDragEnd={() => {
                    setRowDragId(null);
                    setRowDropId(null);
                  }}
                >
                  <button
                    type="button"
                    className="pl-row-main"
                    onClick={() => onPlayTrack?.(openPlaylist, id)}
                    aria-label={`Play ${track.title} by ${track.artist}`}
                    aria-current={isCurrent || undefined}
                  >
                    <span className="pl-index">
                      {isCurrent ? <Equalizer playing={playing} /> : (
                        <>
                          <span className="pl-num">{position + 1}</span>
                          <Play className="pl-hover-play" size={12} fill="currentColor" />
                        </>
                      )}
                    </span>
                    <span className="pl-song">
                      <TrackCover track={track} />
                      <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                    </span>
                    <span className="song-album">{track.album || "Unknown album"}</span>
                    <time>{formatTime(track.duration)}</time>
                  </button>
                  <span className="pl-row-tools">
                    {canReorder ? <GripVertical size={13} className="pl-grip" aria-hidden="true" /> : null}
                    <button
                      type="button"
                      className="pl-remove"
                      title="Remove from playlist"
                      aria-label={`Remove ${track.title} from ${openPlaylist.name}`}
                      onClick={() => void removeFromPlaylist(openPlaylist, id)}
                    >
                      <X size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
            {!playlistTracks.length && openPlaylist.trackIds.length > 0 ? (
              <p className="empty-library playlist-filter-empty">
                {deferredPlaylistQuery ? "No tracks match your search. Clear the search to see the full playlist." : "This playlist’s tracks are not in your library."}
              </p>
            ) : null}
            {!openPlaylist.trackIds.length ? (
              <p className="empty-library">This playlist is empty. Choose Edit to pick songs, or add them from the Library with the playlist button or right-click menu.</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="playlist-tiles custom-scroll">
          {playlists.map((playlist) => (
            <PlaylistTile
              key={playlist.id}
              playlist={playlist}
              byId={byId}
              duration={durationOf(playlist)}
              onOpen={() => setOpenId(playlist.id)}
              onPlay={(shuffle) => onPlay(playlist, shuffle)}
            />
          ))}
          {!playlists.length ? (
            <div className="playlist-empty">
              <Plus size={30} strokeWidth={1.4} />
              <strong>No playlists yet</strong>
              <span>Create one, or heart a song to start Favorites.</span>
              <button type="button" className="secondary-button" onClick={openCreate}><Plus size={14} />Create playlist</button>
            </div>
          ) : null}
        </div>
      )}

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
