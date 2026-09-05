import {useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type UIEvent} from "react";
import {createPortal} from "react-dom";
import {
  Album, ArrowDown, ArrowLeft, ArrowUp, Clock3, ListPlus, LoaderCircle, Music2, Plus, Search, Trash2, UserRound, X,
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
  importing?: boolean;
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

export type LibrarySortDirection = "asc" | "desc";

/**
 * Normalize metadata bitrates to kbps. The server reports bits/second while
 * browser-only tracks can already contain a kbps value.
 */
export const bitrateKbps = (bitrate: number | null | undefined) => {
  if (bitrate == null || !Number.isFinite(bitrate) || bitrate <= 0) return null;
  return bitrate >= 1000 ? bitrate / 1000 : bitrate;
};

/** Display bitrate left of duration — kbps when known. */
export const formatBitrate = (bitrate: number | null | undefined) => {
  const kbps = bitrateKbps(bitrate);
  if (kbps == null || kbps <= 0) return null;
  return `${Math.round(kbps)} kbps`;
};

/** True when a known bitrate is below the lossless-quality threshold. */
export const isLowQualityBitrate = (bitrate: number | null | undefined) => {
  const kbps = bitrateKbps(bitrate);
  return kbps != null && kbps < 320;
};

type SortValue = string | number | null;

function sortValue(track: Track, sort: LibrarySort): SortValue {
  if (sort === "duration") return Number.isFinite(track.duration) ? track.duration : null;
  if (sort === "bitrate") return bitrateKbps(track.bitrate);
  const value = track[sort];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Sort tracks without mutating the source array; missing values stay last. */
export function sortTracks(
  tracks: Track[],
  sort: LibrarySort,
  direction: LibrarySortDirection = "asc",
) {
  return tracks
    .map((track, index) => ({track, index}))
    .sort((a, b) => {
      const av = sortValue(a.track, sort);
      const bv = sortValue(b.track, sort);
      const aMissing = av == null;
      const bMissing = bv == null;
      // Keep unknown metadata at the bottom in either direction.
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing && bMissing) return a.index - b.index;
      let result = 0;
      if (typeof av === "number" && typeof bv === "number") {
        result = av - bv;
      } else {
        result = String(av).localeCompare(String(bv), undefined, {numeric: true, sensitivity: "base"});
      }
      if (result === 0) return a.index - b.index;
      return direction === "asc" ? result : -result;
    })
    .map(({track}) => track);
}

type SortColumnProps = {
  field: LibrarySort;
  label: string;
  sort: LibrarySort;
  direction: LibrarySortDirection;
  onSort: (field: LibrarySort) => void;
  className?: string;
};

function SortColumn({field, label, sort, direction, onSort, className = ""}: SortColumnProps) {
  const active = sort === field;
  const ariaSort = active ? (direction === "asc" ? "ascending" : "descending") : "none";
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : null;
  return (
    <div className={`song-column ${className}`.trim()} role="columnheader" aria-sort={ariaSort}>
      <button
        type="button"
        className={`song-column-button ${active ? "active" : ""}`}
        onClick={() => onSort(field)}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        {Icon ? <Icon size={12} strokeWidth={2} aria-hidden="true" /> : null}
      </button>
    </div>
  );
}

function TrackColumnHeader({
  sort,
  direction,
  onSort,
}: Pick<SortColumnProps, "sort" | "direction" | "onSort">) {
  return (
    <div className="song-column-header" role="row">
      <div className="song-column-grid">
        <span className="song-column-cover" aria-hidden="true" />
        <SortColumn field="title" label="Song name" sort={sort} direction={direction} onSort={onSort} />
        <SortColumn field="artist" label="Author" sort={sort} direction={direction} onSort={onSort} className="song-column-author" />
        <SortColumn field="album" label="Album" sort={sort} direction={direction} onSort={onSort} className="song-column-album" />
        <SortColumn field="bitrate" label="Quality" sort={sort} direction={direction} onSort={onSort} className="song-column-quality" />
        <SortColumn field="duration" label="Length" sort={sort} direction={direction} onSort={onSort} className="song-column-length" />
      </div>
      <span className="song-column-actions" aria-hidden="true" />
    </div>
  );
}

function VirtualTrackList({
  tracks,
  selectedId,
  playlists,
  sort,
  direction,
  TrackCover,
  onPlay,
  onAddPlaylist,
  onRemove,
  removingId,
  onSort,
}: Pick<Props, "tracks" | "selectedId" | "playlists" | "TrackCover" | "onPlay" | "onAddPlaylist" | "onRemove" | "removingId"> & {
  sort: LibrarySort;
  direction: LibrarySortDirection;
  onSort: (field: LibrarySort) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  /** Only one “add to playlist” menu open at a time; closed on pick / outside / Escape. */
  const [openMenuTrackId, setOpenMenuTrackId] = useState<string | null>(null);
  /** Fixed viewport anchor for the open menu. Portalling the popover out of the
   * scrolling list avoids clipping and lets it sit above the persistent player. */
  const [menuAnchor, setMenuAnchor] = useState<{left: number; top: number} | null>(null);
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

  useEffect(() => {
    if (!openMenuTrackId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The popover is portalled to <body>, so it is no longer a descendant of
      // the details element. Treat either surface as an inside click.
      if (target?.closest?.(".song-playlist-menu, .song-menu-popover")) return;
      setOpenMenuTrackId(null);
      setMenuAnchor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuTrackId(null);
        setMenuAnchor(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuTrackId]);

  // Close menu when its row scrolls out of the virtual window.
  useEffect(() => {
    if (!openMenuTrackId) return;
    if (!tracks.some((track) => track.id === openMenuTrackId)) {
      setOpenMenuTrackId(null);
      setMenuAnchor(null);
    }
  }, [openMenuTrackId, tracks]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    if (element.clientHeight !== viewportHeight) setViewportHeight(element.clientHeight);
    if (openMenuTrackId) {
      setOpenMenuTrackId(null);
      setMenuAnchor(null);
    }
  };

  const togglePlaylistMenu = (trackId: string, event: MouseEvent<HTMLElement>) => {
    if (openMenuTrackId === trackId) {
      setOpenMenuTrackId(null);
      setMenuAnchor(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    // Use the pointer location when available so the menu opens directly above
    // the cursor; keyboard activation falls back to the summary bounds.
    const pointerX = event.clientX > 0 ? event.clientX : rect.right;
    const pointerY = event.clientY > 0 ? event.clientY : rect.bottom;
    const viewportWidth = Math.max(
      320,
      typeof window !== "undefined" ? (window.innerWidth || document.documentElement.clientWidth || 1024) : 1024,
    );
    const viewportHeight = Math.max(
      80,
      typeof window !== "undefined" ? (window.innerHeight || document.documentElement.clientHeight || 640) : 640,
    );
    const gap = 8;
    // The popover has a 300px max-height; estimating the natural height keeps
    // the placement stable without a layout read after the portal mounts.
    const estimatedHeight = Math.min(300, Math.max(42, 10 + playlists.length * 34), viewportHeight - gap * 2);
    const width = 190;
    const left = Math.min(viewportWidth - width - gap, Math.max(gap, pointerX - width));
    const opensAbove = pointerY + estimatedHeight + gap > viewportHeight - gap;
    const top = opensAbove
      ? Math.max(gap, pointerY - estimatedHeight - gap)
      : Math.min(viewportHeight - estimatedHeight - gap, pointerY + gap);
    setMenuAnchor({left, top});
    setOpenMenuTrackId(trackId);
  };

  const menuTrack = openMenuTrackId ? tracks.find((track) => track.id === openMenuTrackId) : null;
  const menuPortal = menuTrack && menuAnchor && typeof document !== "undefined"
    ? createPortal(
      <div
        className="song-menu-popover song-menu-popover-portal"
        role="menu"
        style={{left: menuAnchor.left, top: menuAnchor.top}}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {!playlists.length ? <span className="song-menu-empty">No playlists yet</span> : null}
        {playlists.map((playlist) => (
          <button
            type="button"
            key={playlist.id}
            role="menuitem"
            disabled={playlist.trackIds.includes(menuTrack.id)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAddPlaylist(playlist.id, menuTrack.id);
              setOpenMenuTrackId(null);
              setMenuAnchor(null);
            }}
          >
            <Music2 size={13} />{playlist.trackIds.includes(menuTrack.id) ? `In ${playlist.name}` : playlist.name}
          </button>
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <div className="song-table">
      <TrackColumnHeader sort={sort} direction={direction} onSort={onSort} />
      <div ref={containerRef} className="song-list custom-scroll" onScroll={onScroll}>
        <div style={{height: start * ROW_HEIGHT}} aria-hidden="true" />
        {visible.map((track) => {
          const bitrateLabel = formatBitrate(track.bitrate);
          const menuOpen = openMenuTrackId === track.id;
          return (
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
              <span className="song-artist">{track.artist || "Unknown artist"}</span>
              <span className="song-album">{track.album || "Unknown album"}</span>
              <span className={`song-bitrate ${isLowQualityBitrate(track.bitrate) ? "low-quality" : ""}`} title={bitrateLabel ? "Audio bitrate" : "Audio bitrate unavailable"}>
                {bitrateLabel || "—"}
              </span>
              <time className="song-duration">{formatTime(track.duration)}</time>
            </button>
          <div className="song-row-actions">
            <details
              className="song-playlist-menu"
              open={menuOpen}
              onToggle={(event) => {
                // Controlled open state so the menu always dismisses cleanly after a pick.
                const nextOpen = event.currentTarget.open;
                setOpenMenuTrackId(nextOpen ? track.id : (openMenuTrackId === track.id ? null : openMenuTrackId));
              }}
            >
              <summary
                title="Add to playlist"
                aria-label={`Add ${track.title} to a playlist`}
                onClick={(event) => {
                  // Prevent summary default toggle fighting controlled state.
                  event.preventDefault();
                  togglePlaylistMenu(track.id, event);
                }}
              >
                <ListPlus size={14} />
              </summary>
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
          );
        })}
        <div style={{height: Math.max(0, tracks.length - end) * ROW_HEIGHT}} aria-hidden="true" />
      </div>
      {menuPortal}
    </div>
  );
}

export function LibraryView(props: Props) {
  const deferredQuery = useDeferredValue(props.query.trim().toLowerCase());
  const [collection, setCollection] = useState<{kind: "album" | "artist"; name: string} | null>(null);
  const [sortDirection, setSortDirection] = useState<LibrarySortDirection>("asc");
  const sortFieldRef = useRef<LibrarySort>(props.sort);
  const sortedFieldRef = useRef<LibrarySort | null>(null);

  // Keep the local direction in sync if the parent restores a preference or
  // changes the field externally. Clicking a new header always starts ASC.
  useEffect(() => {
    if (sortFieldRef.current !== props.sort) {
      sortFieldRef.current = props.sort;
      sortedFieldRef.current = null;
      setSortDirection("asc");
    }
  }, [props.sort]);

  const handleSort = (field: LibrarySort) => {
    if (field !== sortFieldRef.current) {
      sortFieldRef.current = field;
      sortedFieldRef.current = field;
      setSortDirection("asc");
      props.onSort(field);
      return;
    }
    // The first click on a column establishes ascending order. This keeps a
    // default title sort from unexpectedly jumping to descending on click.
    if (sortedFieldRef.current !== field) {
      sortedFieldRef.current = field;
      setSortDirection("asc");
      return;
    }
    setSortDirection((current) => current === "asc" ? "desc" : "asc");
  };

  const filtered = useMemo(() => {
    const matches = deferredQuery
      ? props.tracks.filter((track) =>
          track.title.toLowerCase().includes(deferredQuery)
          || track.artist.toLowerCase().includes(deferredQuery)
          || track.album.toLowerCase().includes(deferredQuery))
      : props.tracks;
    return sortTracks(matches, props.sort, sortDirection);
  }, [deferredQuery, props.sort, props.tracks, sortDirection]);

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
            onChange={(value) => handleSort(value as LibrarySort)}
            options={[
              {value: "title", label: "Title"},
              {value: "artist", label: "Artist"},
              {value: "album", label: "Album"},
              {value: "bitrate", label: "Quality"},
              {value: "duration", label: "Duration"},
            ]}
          />
          </>
        ) : <button type="button" className="back-link" onClick={() => setCollection(null)}><ArrowLeft size={15} />All {collection.kind}s</button>}
        <div className="library-actions">
          <button type="button" className="primary-button" disabled={props.importing} onClick={props.onImportFiles}><Plus size={14} />{props.importing ? "Importing…" : "Add music"}</button>
          <button type="button" className="quiet-button" disabled={props.importing} onClick={props.onImportFolder}>Folder</button>
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
          {!props.tracks.length ? <button type="button" className="primary-button" disabled={props.importing} onClick={props.onImportFiles}><Plus size={16} />{props.importing ? "Importing…" : "Add music"}</button> : null}
        </div>
      ) : props.mode === "songs" || detailTracks ? (
        <VirtualTrackList
          {...props}
          tracks={detailTracks || filtered}
          sort={props.sort}
          direction={sortDirection}
          onSort={handleSort}
        />
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
