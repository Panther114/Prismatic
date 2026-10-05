import {FolderOpen, Heart, ListEnd, ListPlus, ListStart, Play, Trash2} from "lucide-react";
import {useEffect, useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import type {Playlist, Track} from "../types";

export type ContextMenuState = {x: number; y: number; ids: string[]; openPlaylists?: boolean};

type Props = {
  menu: ContextMenuState;
  tracksById: Map<string, Track>;
  playlists: Playlist[];
  favoriteIds: Set<string>;
  canReveal: boolean;
  onClose: () => void;
  onPlay: (id: string) => void;
  onPlayNext: (ids: string[]) => void;
  onAddToQueue: (ids: string[]) => void;
  onToggleFavorite: (ids: string[]) => void;
  onAddToPlaylist: (playlistId: string, ids: string[]) => void;
  onReveal: (track: Track) => void;
  onRemove: (ids: string[]) => void;
};

const EDGE = 8;

/** Right-click / bulk menu. Rendered in a portal so list scrolling never clips it. */
export function TrackContextMenu(props: Props) {
  const {menu, tracksById, playlists, favoriteIds, canReveal, onClose} = props;
  const root = useRef<HTMLDivElement>(null);
  const [showPlaylists, setShowPlaylists] = useState(Boolean(menu.openPlaylists));
  const [position, setPosition] = useState({left: menu.x, top: menu.y});
  const ids = menu.ids;
  const single = ids.length === 1 ? tracksById.get(ids[0]) : undefined;
  const allFavorite = ids.every((id) => favoriteIds.has(id));
  const countLabel = ids.length > 1 ? ` (${ids.length})` : "";

  // Keep the menu inside the window; flip above/left when it would overflow.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const {width, height} = element.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(menu.x, window.innerWidth - width - EDGE));
    const top = Math.max(EDGE, menu.y + height + EDGE > window.innerHeight ? window.innerHeight - height - EDGE : menu.y);
    setPosition({left, top});
  }, [menu.x, menu.y, showPlaylists]);

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return createPortal(
    <div ref={root} className="context-menu" role="menu" style={position} onContextMenu={(event) => event.preventDefault()}>
      {single ? (
        <button type="button" role="menuitem" onClick={run(() => props.onPlay(single.id))}><Play size={13} />Play</button>
      ) : null}
      <button type="button" role="menuitem" onClick={run(() => props.onPlayNext(ids))}><ListStart size={13} />Play next{countLabel}</button>
      <button type="button" role="menuitem" onClick={run(() => props.onAddToQueue(ids))}><ListEnd size={13} />Add to queue{countLabel}</button>
      <button type="button" role="menuitem" onClick={run(() => props.onToggleFavorite(ids))}>
        <Heart size={13} fill={allFavorite ? "currentColor" : "none"} />
        {allFavorite ? `Remove from favorites${countLabel}` : `Add to favorites${countLabel}`}
      </button>
      <button type="button" role="menuitem" aria-expanded={showPlaylists} onClick={() => setShowPlaylists((open) => !open)}>
        <ListPlus size={13} />Add to playlist{countLabel}
      </button>
      {showPlaylists ? (
        <div className="context-submenu custom-scroll">
          {!playlists.length ? <span className="song-menu-empty">No playlists yet</span> : null}
          {playlists.map((playlist) => (
            <button type="button" role="menuitem" key={playlist.id} onClick={run(() => props.onAddToPlaylist(playlist.id, ids))}>
              {playlist.name}
            </button>
          ))}
        </div>
      ) : null}
      {single && canReveal ? (
        <button type="button" role="menuitem" onClick={run(() => props.onReveal(single))}><FolderOpen size={13} />Show in folder</button>
      ) : null}
      <div className="context-separator" role="separator" />
      <button type="button" role="menuitem" className="danger" onClick={run(() => props.onRemove(ids))}><Trash2 size={13} />Remove from library{countLabel}</button>
    </div>,
    document.body,
  );
}
