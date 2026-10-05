import {useSyncExternalStore} from "react";

export type Toast = {
  id: number;
  kind: "info" | "error";
  text: string;
  actionLabel?: string;
  onAction?: () => void;
};

type ToastInput = Omit<Toast, "id"> & {durationMs?: number};

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const MAX_TOASTS = 3;

function emit() {
  listeners.forEach((listener) => listener());
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const before = toasts.length;
  toasts = toasts.filter((toast) => toast.id !== id);
  if (toasts.length !== before) emit();
}

export function pushToast({durationMs, ...input}: ToastInput): number {
  // Identical text replaces the old toast instead of stacking duplicates.
  const existing = toasts.find((toast) => toast.text === input.text && toast.kind === input.kind);
  if (existing) dismissToast(existing.id);
  const id = nextId++;
  toasts = [...toasts, {...input, id}].slice(-MAX_TOASTS);
  const lifetime = durationMs ?? (input.kind === "error" ? 8000 : input.onAction ? 7000 : 4000);
  timers.set(id, setTimeout(() => dismissToast(id), lifetime));
  emit();
  return id;
}

export const toast = {
  info: (text: string, extra: Partial<ToastInput> = {}) => pushToast({kind: "info", text, ...extra}),
  error: (text: string, extra: Partial<ToastInput> = {}) => pushToast({kind: "error", text, ...extra}),
  clear() {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    toasts = [];
    emit();
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
