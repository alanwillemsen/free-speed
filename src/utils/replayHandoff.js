// One-shot, in-memory handoff of a loaded recording from the Stroke Analysis
// page to the live page. Replays must run on the always-mounted live instance
// because it owns the coach link (the stable peer id a coach's roster dials) —
// the analysis instance deliberately has no peer, so a replay started there
// hands its recording over and navigates home instead of playing locally.
// Module state is fine here: both instances live in the same JS context, and
// a recording can be megabytes — too big for storage-based handoffs.

let pending = null;

// opts: { speed, range } — the replay pace and optional stroke-time window.
export function put(recording, opts = {}) {
  pending = { recording, ...opts };
}

// Returns the pending handoff (or null) and clears it.
export function take() {
  const p = pending;
  pending = null;
  return p;
}
