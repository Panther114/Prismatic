import type {RepeatMode} from "../types";

export type QueueState = {
  /** Ordered track ids for playback (may be shuffled). */
  order: string[];
  /** Unshuffled source order for restore. */
  baseOrder: string[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  sourceLabel: string;
};

export function createQueue(
  trackIds: string[],
  options: {shuffle?: boolean; repeat?: RepeatMode; startId?: string; sourceLabel?: string} = {},
): QueueState {
  const baseOrder = trackIds.filter(Boolean);
  const shuffle = Boolean(options.shuffle);
  const order = shuffle ? shuffleIds(baseOrder) : [...baseOrder];
  let index = 0;
  if (options.startId) {
    const at = order.indexOf(options.startId);
    index = at >= 0 ? at : 0;
    // When shuffle + startId, put start first for immediate play
    if (shuffle && at > 0) {
      order.splice(at, 1);
      order.unshift(options.startId);
      index = 0;
    }
  }
  return {
    order,
    baseOrder,
    index: order.length ? index : -1,
    shuffle,
    repeat: options.repeat ?? "off",
    sourceLabel: options.sourceLabel || "Library",
  };
}

export function currentId(queue: QueueState): string | null {
  if (queue.index < 0 || queue.index >= queue.order.length) return null;
  return queue.order[queue.index] || null;
}

export function setShuffle(queue: QueueState, shuffle: boolean): QueueState {
  const current = currentId(queue);
  if (shuffle === queue.shuffle) return queue;
  if (!shuffle) {
    const order = [...queue.baseOrder];
    const index = current ? Math.max(0, order.indexOf(current)) : 0;
    return {...queue, shuffle: false, order, index: order.length ? index : -1};
  }
  const rest = queue.baseOrder.filter((id) => id !== current);
  const order = current ? [current, ...shuffleIds(rest)] : shuffleIds(queue.baseOrder);
  return {...queue, shuffle: true, order, index: order.length ? 0 : -1};
}

export function setRepeat(queue: QueueState, repeat: RepeatMode): QueueState {
  return {...queue, repeat};
}

export function cycleRepeat(repeat: RepeatMode): RepeatMode {
  if (repeat === "off") return "all";
  if (repeat === "all") return "one";
  return "off";
}

/** Advance after track ended. Returns null id when playback should stop. */
export function onTrackEnded(queue: QueueState): {queue: QueueState; trackId: string | null; autoplay: boolean} {
  if (!queue.order.length || queue.index < 0) {
    return {queue, trackId: null, autoplay: false};
  }
  if (queue.repeat === "one") {
    return {queue, trackId: currentId(queue), autoplay: true};
  }
  const nextIndex = queue.index + 1;
  if (nextIndex < queue.order.length) {
    const next = {...queue, index: nextIndex};
    return {queue: next, trackId: currentId(next), autoplay: true};
  }
  if (queue.repeat === "all") {
    const next = {...queue, index: 0};
    return {queue: next, trackId: currentId(next), autoplay: true};
  }
  return {queue, trackId: null, autoplay: false};
}

export function skipNext(queue: QueueState): {queue: QueueState; trackId: string | null} {
  if (!queue.order.length) return {queue, trackId: null};
  let nextIndex = queue.index + 1;
  if (nextIndex >= queue.order.length) {
    if (queue.repeat === "all" || queue.repeat === "one") nextIndex = 0;
    else return {queue, trackId: currentId(queue)};
  }
  const next = {...queue, index: nextIndex};
  return {queue: next, trackId: currentId(next)};
}

export function skipPrev(
  queue: QueueState,
  currentTime: number,
  restartThreshold = 3,
): {queue: QueueState; trackId: string | null; restart: boolean} {
  if (!queue.order.length) return {queue, trackId: null, restart: false};
  if (currentTime > restartThreshold) {
    return {queue, trackId: currentId(queue), restart: true};
  }
  let prevIndex = queue.index - 1;
  if (prevIndex < 0) {
    if (queue.repeat === "all" || queue.repeat === "one") prevIndex = queue.order.length - 1;
    else return {queue, trackId: currentId(queue), restart: true};
  }
  const next = {...queue, index: prevIndex};
  return {queue: next, trackId: currentId(next), restart: false};
}

export function jumpTo(queue: QueueState, trackId: string): QueueState {
  const index = queue.order.indexOf(trackId);
  if (index < 0) {
    // Track not in queue — append and select
    const order = [...queue.order, trackId];
    const baseOrder = queue.baseOrder.includes(trackId) ? queue.baseOrder : [...queue.baseOrder, trackId];
    return {...queue, order, baseOrder, index: order.length - 1};
  }
  return {...queue, index};
}

export function removeTrackFromQueue(queue: QueueState, trackId: string): QueueState {
  const baseOrder = queue.baseOrder.filter((id) => id !== trackId);
  const order = queue.order.filter((id) => id !== trackId);
  let index = queue.index;
  const wasCurrent = currentId(queue) === trackId;
  if (wasCurrent) {
    index = Math.min(index, order.length - 1);
  } else {
    const cur = currentId(queue);
    index = cur ? order.indexOf(cur) : -1;
  }
  return {...queue, baseOrder, order, index: order.length ? Math.max(0, index) : -1};
}

function shuffleIds(ids: string[]): string[] {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
