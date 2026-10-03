import {useDeferredValue, useEffect, useMemo, useState, type ComponentType, type DragEvent} from "react";
import {
  Archive, ArrowDown, ArrowLeft, ArrowUp, Check, Clapperboard, FileArchive, GripVertical, LoaderCircle, Pencil, Play, Plus, Search, Shuffle, Trash2, X,
} from "lucide-react";
import type {Playlist, Track} from "../types";
import {CustomSelect} from "./CustomSelect";
import {PlaylistCover} from "./PlaylistCover";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

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
  onPlayTrack,
  onExport,
  onExportZip,
  onImportZip,
  zipBusy,
  zipStatus,
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [playlistSort, setPlaylistSort] = useState<PlaylistSort>("order");
  const [playlistSortDirection, setPlaylistSortDirection] = useState<PlaylistSortDirection>("asc");
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
        <div className="playlist-detail-view custom-scroll">
          <button type="button" className="back-link" onClick={() => setOpenId(null)}>
            <ArrowLeft size={15} />View all playlists
          </button>
          <div className="playlist-detail-head">
            <div className="playlist-detail-title">
              <PlaylistCover trackIds={openPlaylist.trackIds} tracksById={byId} size={56} />
              <div>
                <h2>{openPlaylist.name}</h2>
                <p>{openPlaylist.trackIds.length} tracks · {formatTime(durationOf(openPlaylist))}</p>
              </div>
            </div>
            <div className="playlist-row-actions dense">
              <button type="button" className="icon-btn" disabled={!openPlaylist.trackIds.length} onClick={() => onPlay(openPlaylist, false)} title="Play" aria-label={`Play ${openPlaylist.name}`}>
                <Play size={13} fill="currentColor" />
              </button>
              <button type="button" className="icon-btn" disabled={!openPlaylist.trackIds.length} onClick={() => onPlay(openPlaylist, true)} title="Shuffle" aria-label={`Shuffle ${openPlaylist.name}`}>
                <Shuffle size={13} />
              </button>
              {onExportZip ? (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={!openPlaylist.trackIds.length || zipBusy}
                  onClick={() => onExportZip(openPlaylist)}
                  title="Export as zip"
                  aria-label={`Export ${openPlaylist.name} as zip`}
                >
                  {zipBusy ? <LoaderCircle className="spin" size={13} /> : <Archive size={13} />}
                </button>
              ) : null}
              {onExport ? (
                <button type="button" className="icon-btn" disabled={!openPlaylist.trackIds.length || exporting} onClick={() => onExport(openPlaylist)} title="Export video" aria-label={`Export video ${openPlaylist.name}`}>
                  {exporting ? <LoaderCircle className="spin" size={13} /> : <Clapperboard size={13} />}
                </button>
              ) : null}
              <button type="button" className="icon-btn" onClick={() => openEdit(openPlaylist)} title="Edit" aria-label={`Edit ${openPlaylist.name}`}>
                <Pencil size={13} />
              </button>
              <button type="button" className="icon-btn danger" onClick={() => onDelete(openPlaylist.id, openPlaylist.name)} title="Delete" aria-label={`Delete ${openPlaylist.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          <div className="playlist-detail-controls">
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
          <div className="playlist-detail-columns" aria-hidden="true">
            <span />
            <span>Song</span>
            <span className="song-album">Album</span>
            <span>Length</span>
          </div>
          <div className="playlist-detail-list">
            {playlistTracks.map((track) => {
              const id = track.id;
              return (
                <button
                  type="button"
                  key={id}
                  className="playlist-detail-row"
                  onClick={() => onPlayTrack?.(openPlaylist, id)}
                  aria-label={`Play ${track.title} by ${track.artist}`}
                >
                  <TrackCover track={track} />
                  <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
                  <span className="song-album">{track.album || "Unknown album"}</span>
                  <time>{formatTime(track.duration)}</time>
                </button>
              );
            })}
            {!playlistTracks.length && openPlaylist.trackIds.length > 0 ? (
              <p className="empty-library playlist-filter-empty">
                {deferredPlaylistQuery ? "No tracks match your search. Clear the search to see the full playlist." : "This playlist’s tracks are not in your library."}
              </p>
            ) : null}
            {!openPlaylist.trackIds.length ? (
              <p className="empty-library">This playlist has no tracks yet. Edit it and pick some from your library.</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="playlist-tiles custom-scroll">
          {playlists.map((playlist) => (
            <div key={playlist.id} className="playlist-tile">
              <div className="playlist-tile-art">
                <button
                  type="button"
                  className="playlist-tile-open"
                  onClick={() => setOpenId(playlist.id)}
                  aria-label={`Open ${playlist.name}`}
                >
                  <PlaylistCover trackIds={playlist.trackIds} tracksById={byId} size={40} className="tile-cover" />
                </button>
                <span className="tile-actions">
                  <button type="button" className="icon-btn" disabled={!playlist.trackIds.length} onClick={() => onPlay(playlist, false)} title="Play" aria-label={`Play ${playlist.name}`}>
                    <Play size={14} fill="currentColor" />
                  </button>
                  <button type="button" className="icon-btn" disabled={!playlist.trackIds.length} onClick={() => onPlay(playlist, true)} title="Shuffle" aria-label={`Shuffle ${playlist.name}`}>
                    <Shuffle size={14} />
                  </button>
                </span>
              </div>
              <button type="button" className="playlist-tile-copy" onClick={() => setOpenId(playlist.id)}>
                <strong>{playlist.name}</strong>
                <small>{playlist.trackIds.length} tracks · {formatTime(durationOf(playlist))}</small>
              </button>
            </div>
          ))}
          {!playlists.length ? <p className="empty-library">No playlists yet. Create one and select its tracks.</p> : null}
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
