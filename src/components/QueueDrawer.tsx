import {ArrowDown, ArrowUp, ListMusic, Play, Trash2, X} from "lucide-react";
import {currentId, getUpcomingQueue, type QueueState, type UpcomingQueueItem} from "../lib/playbackQueue";
import type {Track} from "../types";

type Props = {
  open: boolean;
  queue: QueueState;
  tracksById: Map<string, Track>;
  onClose: () => void;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onClearUpcoming: () => void;
};

export function QueueDrawer({open, queue, tracksById, onClose, onPlay, onRemove, onMove, onClearUpcoming}: Props) {
  if (!open) return null;
  const current = currentId(queue);
  const currentIndex = current && queue.index >= 0 && queue.index < queue.order.length ? queue.index : -1;
  const upcoming = getUpcomingQueue(queue);
  const rows: UpcomingQueueItem[] = current && currentIndex >= 0
    ? [{id: current, index: currentIndex, cycle: 0}, ...upcoming]
    : upcoming;
  return (
    <aside className="queue-drawer" aria-label="Play queue">
      <header>
        <div><span className="eyebrow">Playing from</span><h2>{queue.sourceLabel}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close queue"><X size={18} /></button>
      </header>
      <div className="queue-summary"><ListMusic size={15} />{queue.order.length} tracks · {upcoming.length} upcoming</div>
      <div className="queue-items custom-scroll">
        {rows.map((item, rowIndex) => {
          const {id, index, cycle} = item;
          const track = tracksById.get(id);
          if (!track) return null;
          const isCurrent = cycle === 0 && index === queue.index;
          const projected = cycle > 0;
          return (
            <article className={`queue-item ${isCurrent ? "current" : ""} ${projected ? "projected" : ""}`} key={`${id}-${cycle}-${rowIndex}`}>
              <button type="button" className="queue-play" onClick={() => onPlay(id)}>
                {isCurrent ? <Play size={12} fill="currentColor" /> : <span>{rowIndex + 1}</span>}
                <img
                  className={track.coverUrl.includes("music-note.") ? "fallback-note" : ""}
                  src={track.coverUrl}
                  alt=""
                  loading="lazy"
                  onError={(event) => {
                    event.currentTarget.src = "/music-note.svg";
                    event.currentTarget.classList.add("fallback-note");
                  }}
                />
                <span><strong>{track.title}</strong><small>{track.artist}</small></span>
              </button>
              <div className="queue-item-actions">
                <button type="button" disabled={projected || index === 0} onClick={() => onMove(index, index - 1)} aria-label={`Move ${track.title} up`}><ArrowUp size={13} /></button>
                <button type="button" disabled={projected || index === queue.order.length - 1} onClick={() => onMove(index, index + 1)} aria-label={`Move ${track.title} down`}><ArrowDown size={13} /></button>
                <button type="button" disabled={projected} onClick={() => onRemove(id)} aria-label={`Remove ${track.title} from queue`}><X size={13} /></button>
              </div>
            </article>
          );
        })}
      </div>
      <button type="button" className="queue-clear" onClick={onClearUpcoming}><Trash2 size={14} />Clear upcoming</button>
    </aside>
  );
}
