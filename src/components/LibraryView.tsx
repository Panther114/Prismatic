import {useDeferredValue, useMemo, useRef, useState, type ComponentType, type UIEvent} from "react";
import {
  Album, ArrowLeft, Clock3, Ellipsis, ListPlus, Music2, Play, Plus, Search, Trash2, UserRound, X,
} from "lucide-react";
import type {LibraryMode, LibrarySort, Playlist, Track} from "../types";

const ROW_HEIGHT = 64;
const OVERSCAN = 7;

type Props = {
  tracks: Track[];
  playlists: Playlist[];
  selectedId: string;
  loading: boolean;
  query: string;
  mode: LibraryMode;
  sort: LibrarySort;
  TrackCover: ComponentType<{track: Track}>;
  onQuery: (value: string) => void;
  onMode: (mode: LibraryMode) => void;
  onSort: (sort: LibrarySort) => void;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
  onPlayNext: (id: string) => void;
  onAddQueue: (id: string) => void;
  onAddPlaylist: (playlistId: string, trackId: string) => void;
  onRemove: (id: string, title: string) => void;
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
  onSelect,
  onPlay,
  onPlayNext,
  onAddQueue,
  onAddPlaylist,
  onRemove,
}: Pick<Props, "tracks" | "selectedId" | "playlists" | "TrackCover" | "onSelect" | "onPlay" | "onPlayNext" | "onAddQueue" | "onAddPlaylist" | "onRemove">) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(tracks.length, start + visibleCount);
  const visible = tracks.slice(start, end);

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
            onClick={() => onSelect(track.id)}
            onDoubleClick={() => onPlay(track.id)}
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
          <details className="song-menu">
            <summary aria-label={`Actions for ${track.title}`}><Ellipsis size={17} /></summary>
            <div className="song-menu-popover">
              <button type="button" onClick={() => onPlay(track.id)}><Play size={14} />Play</button>
              <button type="button" onClick={() => onPlayNext(track.id)}><ListPlus size={14} />Play next</button>
              <button type="button" onClick={() => onAddQueue(track.id)}><Plus size={14} />Add to queue</button>
              {playlists.map((playlist) => (
                <button type="button" key={playlist.id} onClick={() => onAddPlaylist(playlist.id, track.id)}>
                  <Music2 size={14} />Add to {playlist.name}
                </button>
              ))}
              <button type="button" className="danger" onClick={() => onRemove(track.id, track.title)}>
                <Trash2 size={14} />Remove from library
              </button>
            </div>
          </details>
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
        <div>
          <span className="eyebrow">Your music</span>
          <h1 id="library-title">{collection?.name || "Library"}</h1>
          <p>{filtered.length} {filtered.length === 1 ? "track" : "tracks"} ready to play</p>
        </div>
        <div className="library-actions">
          <button type="button" className="primary-button" onClick={props.onImportFiles}><Plus size={16} />Add music</button>
          <button type="button" className="quiet-button" onClick={props.onImportFolder}>Add folder</button>
        </div>
      </header>

      {collection ? (
        <button type="button" className="back-link" onClick={() => setCollection(null)}><ArrowLeft size={15} />All {collection.kind}s</button>
      ) : (
        <div className="library-controls">
          <div className="segmented-control" aria-label="Library view">
            <button type="button" className={props.mode === "songs" ? "active" : ""} onClick={() => props.onMode("songs")}>Songs</button>
            <button type="button" className={props.mode === "albums" ? "active" : ""} onClick={() => props.onMode("albums")}>Albums</button>
            <button type="button" className={props.mode === "artists" ? "active" : ""} onClick={() => props.onMode("artists")}>Artists</button>
          </div>
          <label className="library-search-v2">
            <Search size={16} aria-hidden="true" />
            <input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Search your library" aria-label="Search library" />
            {props.query ? <button type="button" onClick={() => props.onQuery("")} aria-label="Clear search"><X size={14} /></button> : null}
          </label>
          <label className="sort-control">Sort
            <select value={props.sort} onChange={(event) => props.onSort(event.target.value as LibrarySort)}>
              <option value="title">Title</option>
              <option value="artist">Artist</option>
              <option value="album">Album</option>
              <option value="duration">Duration</option>
            </select>
          </label>
        </div>
      )}

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
            const cover = tracks.find((track) => !track.coverUrl.endsWith("music-note.png")) || tracks[0];
            const duration = tracks.reduce((total, track) => total + track.duration, 0);
            return (
              <button
                type="button"
                className="collection-tile"
                key={name}
                onClick={() => setCollection({kind: props.mode === "albums" ? "album" : "artist", name})}
              >
                <span className="collection-art">
                  {cover ? <img src={cover.coverUrl} alt="" loading="lazy" /> : props.mode === "albums" ? <Album /> : <UserRound />}
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
