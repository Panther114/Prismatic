import type {QueueSource, RepeatMode} from "../types";

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
  /** Stable source identity used to keep a playing playlist in sync when it
   * is edited or renamed while playback is active. Older saved queues omit it. */
  source?: QueueSource;
  /** Last canonical order supplied by source (separate from manual queue edits). */
  sourceOrder?: string[];
  updatedAt?: string;
};

export type UpcomingQueueItem = {
  /** Track id in the canonical queue order. */
  id: string;
  /** Index in queue.order (used by reorder/remove actions). */
  index: number;
  /** 0 for the current cycle, 1 for a repeat-all wrap/self-repeat preview. */
  cycle: 0 | 1;
};

export function createQueue(
  trackIds: string[],
  options: {
    shuffle?: boolean;
    repeat?: RepeatMode;
    startId?: string;
    sourceLabel?: string;
    source?: QueueSource;
  } = {},
): QueueState {
  const baseOrder = uniqueIds(trackIds);
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
    ...(options.source ? {source: options.source, sourceOrder: [...baseOrder]} : {}),
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
    const source = parseQueueSource(raw.source) || fallback.source;
    const sourceOrder = Array.isArray(raw.sourceOrder)
      ? uniqueIds(raw.sourceOrder.filter((id): id is string => typeof id === "string" && available.has(id)))
      : fallback.sourceOrder || [...baseOrder];
    return {
      version: 2,
      order,
      baseOrder: baseOrder.length ? baseOrder : [...order],
      index,
      shuffle: Boolean(raw.shuffle),
      repeat: raw.repeat === "all" || raw.repeat === "one" ? raw.repeat : "off",
      sourceLabel: typeof raw.sourceLabel === "string" ? raw.sourceLabel : "Library",
      source,
      sourceOrder,
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
  if (!trackId || currentId(queue) === trackId) return queue;
  const previousIndex = queue.order.indexOf(trackId);
  const without = queue.order.filter((id) => id !== trackId);
  const insertionIndex = Math.max(
    0,
    queue.index + 1 - (previousIndex >= 0 && previousIndex <= queue.index ? 1 : 0),
  );
  without.splice(insertionIndex, 0, trackId);
  const baseOrder = queue.baseOrder.includes(trackId) ? queue.baseOrder : [...queue.baseOrder, trackId];
  const current = currentId(queue);
  return {
    ...queue,
    order: without,
    baseOrder,
    index: current ? without.indexOf(current) : Math.min(queue.index, without.length - 1),
    version: 2,
    updatedAt: new Date().toISOString(),
  };
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

/**
 * Return the next playback cycle in display order. The result is intentionally
 * bounded to one cycle: repeat-all includes each track once after the current
 * item, and repeat-one includes the current item once as its next item. This
 * keeps the queue drawer finite while still showing exactly what will play
 * next in either looping mode.
 */
export function getUpcomingQueue(queue: QueueState): UpcomingQueueItem[] {
  if (!queue.order.length) return [];
  // A malformed/restored queue may have no current index. Treat every item as
  // upcoming rather than hiding the queue entirely; normal queues use -1 only
  // when they are empty.
  if (queue.index < 0 || queue.index >= queue.order.length) {
    return queue.order.map((id, index) => ({id, index, cycle: 0 as const}));
  }
  const upcoming: UpcomingQueueItem[] = [];
  if (queue.repeat === "one") {
    const id = queue.order[queue.index];
    return id ? [{id, index: queue.index, cycle: 1}] : [];
  }
  for (let index = queue.index + 1; index < queue.order.length; index += 1) {
    upcoming.push({id: queue.order[index], index, cycle: 0});
  }
  if (queue.repeat === "all") {
    for (let index = 0; index <= queue.index; index += 1) {
      const id = queue.order[index];
      if (id) upcoming.push({id, index, cycle: 1});
    }
  }
  return upcoming;
}

/** Convenience projection for consumers that only need track ids. */
export function getUpcomingIds(queue: QueueState): string[] {
  return getUpcomingQueue(queue).map(({id}) => id);
}

/** Alias kept terse for UI call sites. */
export const upcomingIds = getUpcomingIds;

/** Keep the current item and discard all explicitly queued successors. Looping
 * modes remain active, so repeat-one/repeat-all can still project the current
 * item as the next playback event without resurrecting older past items. */
export function clearUpcoming(queue: QueueState): QueueState {
  const current = currentId(queue);
  if (!current) {
    return {
      ...queue,
      order: [],
      baseOrder: [],
      index: -1,
      version: 2,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...queue,
    order: [current],
    baseOrder: [current],
    index: 0,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
}
export const upcomingQueue = getUpcomingQueue;

/**
 * Reconcile a queue with a playlist/library source that changed underneath it.
 * The current track is preserved when possible; if it was removed, the first
 * still-available successor is selected, then the first available item. In
 * shuffle mode existing order is retained and only new source ids are appended
 * so a metadata refresh never reshuffles the listener's queue unexpectedly.
 */
export function syncQueueToTrackIds(
  queue: QueueState,
  trackIds: string[],
  source?: QueueSource,
): QueueState {
  const sourceOrder = uniqueIds(trackIds);
  const previousSourceOrder = uniqueIds(queue.sourceOrder || queue.baseOrder);
  const available = new Set(sourceOrder);
  const queueOrder = uniqueIds(queue.order);
  // A queue action can remove an item without editing its playlist. Keep that
  // omission stable across source refreshes; an explicit remove/re-add in the
  // playlist changes sourceOrder and therefore makes the id eligible again.
  const manuallyRemoved = new Set(
    previousSourceOrder.filter((id) => !queueOrder.includes(id) && available.has(id)),
  );
  const oldCurrent = currentId(queue);
  const successor = oldCurrent && available.has(oldCurrent)
    ? oldCurrent
    : queue.order.slice(Math.max(0, queue.index + 1)).find((id) => available.has(id))
      || sourceOrder.find((id) => !manuallyRemoved.has(id))
      || null;
  const sourceOrderChanged = !sameIds(previousSourceOrder, sourceOrder);
  const retained = queueOrder.filter((id) => available.has(id));
  const retainedSet = new Set(retained);
  const newlyAdded = sourceOrder.filter((id) => !previousSourceOrder.includes(id));
  const extras = retained.filter((id) => !sourceOrder.includes(id));
  const order = queue.shuffle || !sourceOrderChanged
    ? [...retained, ...newlyAdded.filter((id) => !retainedSet.has(id))]
    : [
      ...sourceOrder.filter((id) =>
        (retainedSet.has(id) || !previousSourceOrder.includes(id)) && !manuallyRemoved.has(id)),
      ...extras,
    ];
  const orderSet = new Set(order);
  const baseOrder = [
    ...sourceOrder.filter((id) => orderSet.has(id)),
    ...extras.filter((id) => !sourceOrder.includes(id)),
  ];
  const index = successor ? order.indexOf(successor) : -1;
  const nextSource = source || queue.source;
  const sourceLabel = nextSource?.kind === "playlist"
    ? nextSource.name
    : nextSource?.kind === "library"
      ? "Library"
      : queue.sourceLabel;
  return {
    ...queue,
    order,
    baseOrder,
    index: index >= 0 ? index : (order.length ? 0 : -1),
    source: nextSource,
    sourceOrder,
    sourceLabel,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
}

/** Remove ids that disappeared from the library while preserving manual queue
 * edits. Unlike syncQueueToTrackIds this never adds newly imported tracks. */
export function pruneQueueToTrackIds(queue: QueueState, trackIds: string[]): QueueState {
  const available = new Set(uniqueIds(trackIds));
  const current = currentId(queue);
  const order = queue.order.filter((id) => available.has(id));
  const baseOrder = queue.baseOrder.filter((id) => available.has(id));
  const index = current && available.has(current)
    ? order.indexOf(current)
    : Math.min(queue.index, order.length - 1);
  return {
    ...queue,
    order,
    baseOrder,
    sourceOrder: queue.sourceOrder?.filter((id) => available.has(id)),
    index: order.length ? Math.max(0, index) : -1,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
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
    // Prefer the item that followed the removed one. At the end of a looping
    // queue, wrap to the first item; non-looping playback falls back to the
    // previous final item.
    index = index < order.length
      ? index
      : (queue.repeat === "all" || queue.repeat === "one" ? 0 : order.length - 1);
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

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function parseQueueSource(raw: unknown): QueueSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as {kind?: unknown; playlistId?: unknown; name?: unknown};
  if (value.kind === "library") return {kind: "library"};
  if (value.kind === "playlist" && typeof value.playlistId === "string" && typeof value.name === "string") {
    return {kind: "playlist", playlistId: value.playlistId, name: value.name};
  }
  return undefined;
}
