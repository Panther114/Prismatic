const KEY = "prismatic.resume.v1";

export type ResumePoint = {trackId: string; position: number};

/** Positions this close to either end are not worth resuming. */
const START_GUARD = 3;
const END_GUARD = 5;

export function shouldResume(position: number, duration: number): boolean {
  if (!Number.isFinite(position) || position <= START_GUARD) return false;
  if (Number.isFinite(duration) && duration > 0 && position >= duration - END_GUARD) return false;
  return true;
}

export function loadResumePoint(): ResumePoint | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResumePoint>;
    if (typeof parsed.trackId !== "string" || !parsed.trackId) return null;
    if (typeof parsed.position !== "number" || !Number.isFinite(parsed.position) || parsed.position < 0) return null;
    return {trackId: parsed.trackId, position: parsed.position};
  } catch {
    return null;
  }
}

export function saveResumePoint(point: ResumePoint | null) {
  try {
    if (!point) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({trackId: point.trackId, position: Math.floor(point.position * 10) / 10}));
  } catch {
    // Storage unavailable: resuming is a convenience only.
  }
}
