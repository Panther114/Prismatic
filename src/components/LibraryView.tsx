import {useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentType, type UIEvent} from "react";
import {
  Album, ArrowLeft, Clock3, ListPlus, LoaderCircle, Music2, Plus, Search, Trash2, UserRound, X,
} from "lucide-react";
import type {LibraryMode, LibrarySort, Playlist, Track} from "../types";
import {CustomSelect} from "./CustomSelect";

const ROW_HEIGHT = 40;
const OVERSCAN = 7;

type Props = {
  tracks: Track[];
  playlists: Playlist[];
  selectedId: string;
  loading: boolean;
  removingId: string;
  query: string;
  mode: LibraryMode;
  sort: LibrarySort;
  TrackCover: ComponentType<{track: Track}>;
  onQuery: (value: string) => void;
  onMode: (mode: LibraryMode) => void;
  onSort: (sort: LibrarySort) => void;
  onPlay: (id: string) => void;
  onAddPlaylist: (playlistId: string, trackId: string) => void;
  onRemove: (id: string, title: string) => void;
  onClear: () => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
};

const formatTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};

function sortTracks(tracks: Track[], sort: LibrarySort) {
  return [...tracks].sort((a, b) => {
    if (sort === "duration") return a.duration - b.duration;
    return (a[sort] || "").localeCompare(b[sort] || "", undefined, {numeric: true, sensitivity: "base"});
  });
}
function VirtualTrackList({
  tracks,
  selectedId,
  playlists,
  TrackCover,
  onPlay,
  onAddPlaylist,
  onRemove,
  removingId,
}: Pick<Props, "tracks" | "selectedId" | "playlists" | "TrackCover" | "onPlay" | "onAddPlaylist" | "onRemove" | "removingId">) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(tracks.length, start + visibleCount);
  const visible = tracks.slice(start, end);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const height = element.clientHeight;
      if (height > 0) setViewportHeight(height);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tracks.length]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    if (element.clientHeight !== viewportHeight) setViewportHeight(element.clientHeight);
  };

  return (
    <div ref={containerRef} className="song-list custom-scroll" onScroll={onScroll}>
      <div style={{height: start * ROW_HEIGHT}} aria-hidden="true" />
      {visible.map((track) => (
        <article key={track.id} className={`song-row ${selectedId === track.id ? "selected" : ""}`}>
          <button
            type="button"
            className="song-main"
            onClick={(event) => {
              onPlay(track.id);
              if (event.detail > 0) event.currentTarget.blur();
            }}
            aria-label={`${track.title} by ${track.artist}`}
          >
            <TrackCover track={track} />
            <span className="song-copy">
              <strong>{track.title}</strong>
              <small>{track.artist}</small>
            </span>
            <span className="song-album">{track.album || "Unknown album"}</span>
            <time>{formatTime(track.duration)}</time>
          </button>
          <div className="song-row-actions">
            <details className="song-playlist-menu">
              <summary title="Add to playlist" aria-label={`Add ${track.title} to a playlist`}><ListPlus size={14} /></summary>
              <div className="song-menu-popover">
                {!playlists.length ? <span className="song-menu-empty">No playlists yet</span> : null}
              {playlists.map((playlist) => (
                <button
                  type="button"
                  key={playlist.id}
                  disabled={playlist.trackIds.includes(track.id)}
                  onClick={(event) => {
                    onAddPlaylist(playlist.id, track.id);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  <Music2 size={13} />{playlist.trackIds.includes(track.id) ? `In ${playlist.name}` : playlist.name}
                </button>
              ))}
              </div>
            </details>
            <button
              type="button"
              className="song-remove"
              title="Remove from library"
              aria-label={`Remove ${track.title} from library`}
              disabled={removingId === track.id}
              onClick={() => onRemove(track.id, track.title)}
            >
              {removingId === track.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
            </button>
          </div>
        </article>
      ))}
      <div style={{height: Math.max(0, tracks.length - end) * ROW_HEIGHT}} aria-hidden="true" />
    </div>
  );
}

export function LibraryView(props: Props) {
  const deferredQuery = useDeferredValue(props.query.trim().toLowerCase());
  const [collection, setCollection] = useState<{kind: "album" | "artist"; name: string} | null>(null);

  const filtered = useMemo(() => {
    const matches = deferredQuery
      ? props.tracks.filter((track) =>
          track.title.toLowerCase().includes(deferredQuery)
          || track.artist.toLowerCase().includes(deferredQuery)
          || track.album.toLowerCase().includes(deferredQuery))
      : props.tracks;
    return sortTracks(matches, props.sort);
  }, [deferredQuery, props.sort, props.tracks]);

  const groups = useMemo(() => {
    const field = props.mode === "albums" ? "album" : "artist";
    const map = new Map<string, Track[]>();
    for (const track of filtered) {
      const value = track[field].trim() || (field === "album" ? "Unknown album" : "Unknown artist");
      const list = map.get(value);
      if (list) list.push(track);
      else map.set(value, [track]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, {sensitivity: "base"}));
  }, [filtered, props.mode]);

  const detailTracks = collection
    ? filtered.filter((track) =>
        collection.kind === "album"
          ? (track.album.trim() || "Unknown album") === collection.name
          : (track.artist.trim() || "Unknown artist") === collection.name)
    : null;

  return (
    <section className="library-v2" aria-labelledby="library-title">
      <header className="library-toolbar">
        <div className="library-title-compact">
          <span className="eyebrow">Your music</span>
          <h1 id="library-title">{collection?.name || "Library"}</h1>
          <p>{filtered.length} {filtered.length === 1 ? "track" : "tracks"}</p>
        </div>
        {!collection ? (
          <>
          <div className="segmented-control" aria-label="Library view">
            <button type="button" className={props.mode === "songs" ? "active" : ""} onClick={() => props.onMode("songs")}>Songs</button>
            <button type="button" className={props.mode === "albums" ? "active" : ""} onClick={() => props.onMode("albums")}>Albums</button>
            <button type="button" className={props.mode === "artists" ? "active" : ""} onClick={() => props.onMode("artists")}>Artists</button>
          </div>
          <label className="library-search-v2">
            <Search size={14} aria-hidden="true" />
            <input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Search your library" aria-label="Search library" />
            {props.query ? <button type="button" onClick={() => props.onQuery("")} aria-label="Clear search"><X size={14} /></button> : null}
          </label>
          <CustomSelect
            className="library-sort-select"
            ariaLabel="Sort library"
            value={props.sort}
            onChange={(value) => props.onSort(value as LibrarySort)}
            options={[
              {value: "title", label: "Title"},
              {value: "artist", label: "Artist"},
              {value: "album", label: "Album"},
              {value: "duration", label: "Duration"},
            ]}
          />
          </>
        ) : <button type="button" className="back-link" onClick={() => setCollection(null)}><ArrowLeft size={15} />All {collection.kind}s</button>}
        <div className="library-actions">
          <button type="button" className="primary-button" onClick={props.onImportFiles}><Plus size={14} />Add music</button>
          <button type="button" className="quiet-button" onClick={props.onImportFolder}>Folder</button>
          <button type="button" className="quiet-button danger" disabled={!props.tracks.length} onClick={props.onClear} title="Clear library"><Trash2 size={14} /><span>Clear</span></button>
        </div>
      </header>

      {props.loading ? (
        <div className="library-skeleton" aria-label="Loading library">
          {Array.from({length: 8}, (_, index) => <i key={index} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="library-empty">
          <Music2 size={34} />
          <h2>{props.tracks.length ? "No matches" : "Your library is ready for music"}</h2>
          <p>{props.tracks.length ? "Try another title, artist, or album." : "Add files or watch a folder. Prismatic keeps the originals untouched."}</p>
          {!props.tracks.length ? <button type="button" className="primary-button" onClick={props.onImportFiles}><Plus size={16} />Add music</button> : null}
        </div>
      ) : props.mode === "songs" || detailTracks ? (
        <VirtualTrackList {...props} tracks={detailTracks || filtered} />
      ) : (
        <div className="collection-grid custom-scroll">
          {groups.map(([name, tracks]) => {
            const cover = tracks.find((track) => !track.coverUrl.includes("music-note.")) || tracks[0];
            const duration = tracks.reduce((total, track) => total + track.duration, 0);
            return (
              <button
                type="button"
                className="collection-tile"
                key={name}
                onClick={() => setCollection({kind: props.mode === "albums" ? "album" : "artist", name})}
              >
                <span className="collection-art">
                  {cover ? <img className={cover.coverUrl.includes("music-note.") ? "fallback-note" : ""} src={cover.coverUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.src = "/music-note.svg"; event.currentTarget.classList.add("fallback-note"); }} /> : props.mode === "albums" ? <Album /> : <UserRound />}
                </span>
                <strong>{name}</strong>
                <small>{tracks.length} tracks <Clock3 size={11} /> {formatTime(duration)}</small>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
