import {ArrowDown, ArrowUp, ListMusic, Play, Trash2, X} from "lucide-react";
import type {QueueState} from "../lib/playbackQueue";
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
  return (
    <aside className="queue-drawer" aria-label="Play queue">
      <header>
        <div><span className="eyebrow">Playing from</span><h2>{queue.sourceLabel}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close queue"><X size={18} /></button>
      </header>
      <div className="queue-summary"><ListMusic size={15} />{queue.order.length} tracks</div>
      <div className="queue-items custom-scroll">
        {queue.order.map((id, index) => {
          const track = tracksById.get(id);
          if (!track) return null;
          return (
            <article className={`queue-item ${index === queue.index ? "current" : ""}`} key={id}>
              <button type="button" className="queue-play" onClick={() => onPlay(id)}>
                {index === queue.index ? <Play size={12} fill="currentColor" /> : <span>{index + 1}</span>}
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
                <button type="button" disabled={index === 0} onClick={() => onMove(index, index - 1)} aria-label={`Move ${track.title} up`}><ArrowUp size={13} /></button>
                <button type="button" disabled={index === queue.order.length - 1} onClick={() => onMove(index, index + 1)} aria-label={`Move ${track.title} down`}><ArrowDown size={13} /></button>
                <button type="button" onClick={() => onRemove(id)} aria-label={`Remove ${track.title} from queue`}><X size={13} /></button>
              </div>
            </article>
          );
        })}
      </div>
      <button type="button" className="queue-clear" onClick={onClearUpcoming}><Trash2 size={14} />Clear upcoming</button>
    </aside>
  );
}
