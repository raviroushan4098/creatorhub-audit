// Head-gesture detector: a nod (up/down) or a shake (left/right).
// Feed it face landmarks every frame; it returns 'nod', 'shake' or null.
//
// Head angle is estimated from where the nose tip sits relative to the eyes,
// divided by the distance between the eyes so it doesn't depend on how far
// you sit from the camera. Then:
//  1. The angle is lightly smoothed to remove webcam jitter.
//  2. "Neutral" is the median head position over the last few seconds, so a
//     slow nod (which swings evenly both ways) doesn't drag it along, while
//     leaning or looking down for a while is absorbed.
//  3. A gesture is three alternating swings past a threshold (e.g.
//     down-up-down) within a time window. The threshold never drops below a
//     few times the measured jitter, so high sensitivity stays stable in poor
//     light.

export const SENSITIVITY = {
  low:    { yawThreshold: 0.07,  pitchThreshold: 0.06,  windowMs: 2200 },
  medium: { yawThreshold: 0.045, pitchThreshold: 0.04,  windowMs: 3000 },
  high:   { yawThreshold: 0.032, pitchThreshold: 0.028, windowMs: 3800 },
};

export const DEFAULTS = {
  ...SENSITIVITY.medium,
  swings: 3,          // alternating excursions needed (e.g. down-up-down)
  returnFactor: 0.75, // a swing back to the other side only needs 75% of the threshold
  cooldownMs: 1500,   // ignore movement right after a gesture
  smoothMs: 50,       // jitter smoothing time constant
  baselineMs: 4000,   // neutral = median position over this long
  noiseFactor: 4,     // threshold is at least this many times the measured jitter
};

// MediaPipe face mesh indices
const NOSE_TIP = 1, LEFT_EYE_OUTER = 33, RIGHT_EYE_OUTER = 263;

export function headPose(lm) {
  const l = lm[LEFT_EYE_OUTER], r = lm[RIGHT_EYE_OUTER], n = lm[NOSE_TIP];
  const d = Math.hypot(r.x - l.x, r.y - l.y) || 1;
  return { yaw: (n.x - (l.x + r.x) / 2) / d, pitch: (n.y - (l.y + r.y) / 2) / d };
}

// ---------- nearest-face selection ----------
// With several people in view, only the face nearest the camera (largest eye
// distance) counts. Once locked on, we stay with that person unless someone
// clearly closer appears, so a person walking behind can't take over.

export const FACE_DEFAULTS = {
  minEyeDist: 0.09,   // ignore faces smaller than this (fraction of frame width): roughly >1.5 m away
                      // on a laptop camera, so someone behind can't take over if you step away
  switchRatio: 1.35,  // another face must be this much bigger to take over
  maxJump: 0.25,      // how far (frame fraction) the locked face may move between frames
};

export function faceBox(lm) {
  const l = lm[LEFT_EYE_OUTER], r = lm[RIGHT_EYE_OUTER];
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return {
    size: Math.hypot(r.x - l.x, r.y - l.y),
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    minX, minY, maxX, maxY,
  };
}

// faces: array of landmark arrays. prev: the box returned last frame (or null).
// Returns { index, box, switched } or null when no usable face is in view.
export function pickNearestFace(faces, prev, options = {}) {
  const o = { ...FACE_DEFAULTS, ...options };
  const boxes = faces.map(faceBox);
  const usable = boxes.map((b, i) => ({ b, i })).filter(({ b }) => b.size >= o.minEyeDist);
  if (!usable.length) return null;
  const largest = usable.reduce((a, c) => (c.b.size > a.b.size ? c : a));
  if (prev) {
    const same = usable
      .map((f) => ({ ...f, d: Math.hypot(f.b.cx - prev.cx, f.b.cy - prev.cy) }))
      .filter((f) => f.d <= o.maxJump)
      .sort((a, b) => a.d - b.d)[0];
    if (same && largest.b.size < same.b.size * o.switchRatio) {
      return { index: same.i, box: same.b, switched: false };
    }
  }
  return { index: largest.i, box: largest.b, switched: !!prev };
}

// ---------- gesture detection ----------

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function axis(threshold) {
  return { threshold, smooth: null, prev: null, prev2: null, jitter: 0, history: [], side: 0, swings: [], level: 0 };
}

function track(ax, raw, now, dt, o) {
  // 1. smoothing + jitter estimate. Jitter comes from the frame-to-frame
  // second difference, which is large for camera noise but small for smooth
  // head motion, so real movement isn't mistaken for noise.
  if (ax.smooth === null) ax.smooth = raw;
  if (ax.prev2 !== null) ax.jitter += (Math.abs(raw - 2 * ax.prev + ax.prev2) / 2.45 - ax.jitter) * 0.03;
  ax.prev2 = ax.prev;
  ax.prev = raw;
  const a = 1 - Math.exp(-dt / o.smoothMs);
  ax.smooth += (raw - ax.smooth) * a;

  // 2. median baseline, sampled every 100 ms
  const last = ax.history[ax.history.length - 1];
  if (!last || now - last.t >= 100) ax.history.push({ t: now, v: ax.smooth });
  while (ax.history.length && now - ax.history[0].t > o.baselineMs) ax.history.shift();
  const base = median(ax.history.map((h) => h.v));

  // 3. alternating excursions
  const T = Math.max(ax.threshold, ax.jitter * o.noiseFactor);
  const dev = ax.smooth - base;
  const need = (side) => (ax.side === -side ? T * o.returnFactor : T);
  let side = 0;
  if (dev > need(1)) side = 1;
  else if (dev < -need(-1)) side = -1;
  if (side !== 0 && side !== ax.side) {
    ax.side = side;
    ax.swings.push({ t: now, amp: Math.abs(dev) / T });
  }
  ax.swings = ax.swings.filter((s) => now - s.t <= o.windowMs);
  ax.level = dev / T; // for the on-screen meter: ±1 = at the threshold
}

export function createDetector(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const yaw = axis(o.yawThreshold);
  const pitch = axis(o.pitchThreshold);
  let quietUntil = 0;
  let lastNow = null;

  const clearSwings = () => { for (const ax of [yaw, pitch]) { ax.swings = []; ax.side = 0; } };

  return {
    update(pose, now) {
      const dt = lastNow === null ? 33 : Math.min(200, Math.max(1, now - lastNow));
      lastNow = now;
      track(yaw, pose.yaw, now, dt, o);
      track(pitch, pose.pitch, now, dt, o);
      if (now < quietUntil) { clearSwings(); return null; }
      const y = yaw.swings.length >= o.swings;
      const p = pitch.swings.length >= o.swings;
      if (!y && !p) return null;
      // If both axes moved, the one that moved more (relative to its threshold) wins.
      const score = (ax) => ax.swings.reduce((s, w) => s + w.amp, 0);
      const result = y && (!p || score(yaw) > score(pitch)) ? 'shake' : 'nod';
      clearSwings();
      quietUntil = now + o.cooldownMs;
      return result;
    },
    // Current movement relative to the threshold, for a live meter (±1 = threshold).
    levels() {
      return { yaw: yaw.level, pitch: pitch.level, yawSwings: yaw.swings.length, pitchSwings: pitch.swings.length, needed: o.swings };
    },
    // Call when the face is lost so stale swings don't combine with new ones.
    lost() {
      clearSwings();
      lastNow = null;
    },
  };
}
