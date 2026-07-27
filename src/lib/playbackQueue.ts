import type {RepeatMode} from "../types";

export type QueueState = {
  version?: 2;
  /** Ordered track ids for playback (may be shuffled). */
  order: string[];
  /** Unshuffled source order for restore. */
  baseOrder: string[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  sourceLabel: string;
  updatedAt?: string;
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
    version: 2,
    order,
    baseOrder,
    index: order.length ? index : -1,
    shuffle,
    repeat: options.repeat ?? "off",
    sourceLabel: options.sourceLabel || "Library",
    updatedAt: new Date().toISOString(),
  };
}

const QUEUE_KEY = "prismatic.queue.v2";

export function loadQueue(trackIds: string[], fallback: QueueState): QueueState {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null") as Partial<QueueState> | null;
    if (!raw || !Array.isArray(raw.order) || !Array.isArray(raw.baseOrder)) return fallback;
    const available = new Set(trackIds);
    const order = raw.order.filter((id): id is string => typeof id === "string" && available.has(id));
    const baseOrder = raw.baseOrder.filter((id): id is string => typeof id === "string" && available.has(id));
    if (!order.length) return fallback;
    const current = typeof raw.index === "number" ? raw.order[raw.index] : null;
    const index = current ? Math.max(0, order.indexOf(current)) : 0;
    return {
      version: 2,
      order,
      baseOrder: baseOrder.length ? baseOrder : [...order],
      index,
      shuffle: Boolean(raw.shuffle),
      repeat: raw.repeat === "all" || raw.repeat === "one" ? raw.repeat : "off",
      sourceLabel: typeof raw.sourceLabel === "string" ? raw.sourceLabel : "Library",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return fallback;
  }
}

export function saveQueue(queue: QueueState) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({...queue, version: 2, updatedAt: new Date().toISOString()}));
  } catch {
    // Storage may be disabled; playback continues in memory.
  }
}

export function enqueueNext(queue: QueueState, trackId: string): QueueState {
  const without = queue.order.filter((id) => id !== trackId);
  without.splice(Math.max(0, queue.index + 1), 0, trackId);
  const baseOrder = queue.baseOrder.includes(trackId) ? queue.baseOrder : [...queue.baseOrder, trackId];
  return {...queue, order: without, baseOrder, version: 2, updatedAt: new Date().toISOString()};
}

export function enqueueLast(queue: QueueState, trackId: string): QueueState {
  if (queue.order.includes(trackId)) return queue;
  return {
    ...queue,
    order: [...queue.order, trackId],
    baseOrder: [...queue.baseOrder, trackId],
    version: 2,
    updatedAt: new Date().toISOString(),
  };
}

export function reorderQueue(queue: QueueState, from: number, to: number): QueueState {
  if (from < 0 || to < 0 || from >= queue.order.length || to >= queue.order.length || from === to) return queue;
  const order = [...queue.order];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const current = currentId(queue);
  return {...queue, order, index: current ? order.indexOf(current) : -1, updatedAt: new Date().toISOString()};
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
