import { useState, useRef } from 'react';

const STROKE = ['speed', 'effort', 'rate', 'handLength', 'ratio'];
const RIGGING = ['outboard', 'inboard', 'span'];
const ALL = [...STROKE, ...RIGGING];

const LABELS = {
  speed: 'Boat speed',
  rate: 'Stroke rate',
  handLength: 'Drive length (hands)',
  ratio: 'Ratio (recovery / drive)',
  effort: 'Effort (energy spent)',
  outboard: 'Oar outboard',
  inboard: 'Oar inboard',
  span: 'Span / spread',
  bladeLength: 'Drive length (blade)',
};

const DESCRIPTIONS = {
  speed: 'How fast the boat travels.',
  rate: 'Strokes per minute.',
  handLength: 'How far the rower pulls the handle on each stroke.',
  ratio: 'How long the recovery is relative to the drive — higher = smoother run between strokes.',
  effort: 'Energy the rower spends per stroke.',
  outboard: 'Pin to blade tip — longer = heavier gearing, longer blade arc.',
  inboard: 'Handle to pin — longer = lighter gearing, shorter blade arc.',
  span: 'Distance between the pins — wider = lighter gearing, shorter blade arc.',
  bladeLength: 'How far the blade travels through the water — derived from hand length and rigging.',
};

// Two abstract relationships govern the system:
//   E1 (kinematic):  speed ∝ rate × bladeLength × √ratio
//                    bladeLength ≡ handLength × outboard / (inboard × span)
//   E2 (cost):       effort ∝ speed³
//
// The √ratio keeps the locked-case physics right: at fixed everything else,
// raising rate forces ratio to drop (recovery time can't grow when the
// period shrinks). Trade-off: in the unconstrained "raise effort" case the
// model puts a small ratio↑ rather than the racing-intuition ratio↓.
//
// Each row encodes the coefficient of log(value) such that
// Σ coeff_i × log(v_i) stays constant when valid moves are made.
const A_ROWS = [
  // E1:  log(speed) − log(rate) − log(handLength) − log(outboard) + log(inboard) + log(span) − ½·log(ratio) = const
  { speed: +1, rate: -1, handLength: -1, ratio: -0.5, effort:  0, outboard: -1, inboard: +1, span: +1 },
  // E2:  log(effort) − 3·log(speed) = const
  { speed: -3, rate:  0, handLength:  0, ratio:  0,   effort: +1, outboard:  0, inboard:  0, span:  0 },
];

// Derived display only — never directly moved by the user, never locked.
function computeBladeLength(v) {
  return (v.handLength * v.outboard) / (v.inboard * v.span) * INITIAL;
}

const MIN = 10;
const MAX = 100;
const INITIAL = 50;

// Solve A_Y · Δ_Y = b for Δ_Y using the minimum-norm (Moore-Penrose) solution.
// `equations` lists which rows of A_ROWS are active. Returns an array of Δs
// aligned with `absorbers`, or null if the system is inconsistent. Tikhonov
// regularization keeps the inverse numerically defined when A_Y · A_Yᵀ is
// rank-deficient; the residual check then catches the truly inconsistent cases.
function solveAbsorbers(equations, absorbers, b) {
  if (absorbers.length === 0) {
    if (b.every(bi => Math.abs(bi) < 1e-9)) return [];
    return null;
  }
  if (equations.length === 1) {
    // Single equation: Δ_Y = ay^T · (ay · ay^T)^{-1} · b → element-wise ay[i]·b/m.
    const ay = absorbers.map(a => A_ROWS[equations[0]][a]);
    const m = ay.reduce((s, v) => s + v * v, 0);
    if (m < 1e-12) {
      if (Math.abs(b[0]) < 1e-9) return absorbers.map(_ => 0);
      return null;
    }
    return ay.map(c => (c * b[0]) / m);
  }
  // Two equations.
  const ay0 = absorbers.map(a => A_ROWS[equations[0]][a]);
  const ay1 = absorbers.map(a => A_ROWS[equations[1]][a]);
  const eps = 1e-8;
  let m00 = eps, m01 = 0, m11 = eps;
  for (let i = 0; i < absorbers.length; i++) {
    m00 += ay0[i] * ay0[i];
    m01 += ay0[i] * ay1[i];
    m11 += ay1[i] * ay1[i];
  }
  const det = m00 * m11 - m01 * m01;
  const inv00 = m11 / det;
  const inv01 = -m01 / det;
  const inv11 = m00 / det;
  const u0 = inv00 * b[0] + inv01 * b[1];
  const u1 = inv01 * b[0] + inv11 * b[1];
  const dY = absorbers.map((_, i) => ay0[i] * u0 + ay1[i] * u1);
  let r0 = -b[0], r1 = -b[1];
  for (let i = 0; i < absorbers.length; i++) {
    r0 += ay0[i] * dY[i];
    r1 += ay1[i] * dY[i];
  }
  if (Math.sqrt(r0 * r0 + r1 * r1) > 1e-4) return null;
  return dY;
}

export default function Tradeoffs({ onBack }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(ALL.map(k => [k, INITIAL]))
  );
  const [locked, setLocked] = useState(() =>
    Object.fromEntries(ALL.map(k => [k, false]))
  );
  const [blocked, setBlocked] = useState(null);
  const blockedTimer = useRef(null);

  const flashBlocked = (name) => {
    setBlocked(name);
    if (blockedTimer.current) clearTimeout(blockedTimer.current);
    blockedTimer.current = setTimeout(() => setBlocked(null), 700);
  };

  const handleSliderChange = (name, target) => {
    if (locked[name]) return;
    const current = values[name];
    if (target === current) return;

    const isRigging = RIGGING.includes(name);
    const strokeAbsorbers = STROKE.filter(v => v !== name && !locked[v]);
    const riggingAbsorbers = RIGGING.filter(v => v !== name && !locked[v]);

    // Three resolution strategies, tried in order:
    //   (1) Both equations, stroke absorbers only — the normal case.
    //   (2) Both equations, stroke + rigging absorbers — only when the user
    //       moves a rigging slider and the stroke side can't take it (e.g. all
    //       stroke locked, or speed is fixed by E1 and rigging conflicts E2).
    //   (3) Drop E1, stroke absorbers — only when the user moves a stroke var
    //       with rate AND length both locked. Treats "drive length" as soft so
    //       extra effort can buy speed via the cube relation.
    const tryMove = (newTarget) => {
      const dX = Math.log(newTarget) - Math.log(current);

      const apply = (equations, absorbers) => {
        const cX = equations.map(eq => A_ROWS[eq][name]);
        const b = cX.map(c => -c * dX);
        const dY = solveAbsorbers(equations, absorbers, b);
        if (dY === null) return null;
        const next = { ...values, [name]: newTarget };
        for (let i = 0; i < absorbers.length; i++) {
          const aNew = values[absorbers[i]] * Math.exp(dY[i]);
          if (aNew < MIN || aNew > MAX) return null;
          next[absorbers[i]] = aNew;
        }
        return next;
      };

      let r = apply([0, 1], strokeAbsorbers);
      if (r) return r;
      if (isRigging) {
        r = apply([0, 1], [...strokeAbsorbers, ...riggingAbsorbers]);
        if (r) return r;
      }
      if (!isRigging && locked.rate && locked.handLength && locked.ratio) {
        r = apply([1], strokeAbsorbers);
        if (r) return r;
      }
      return null;
    };

    let result = tryMove(target);
    if (!result) {
      // Bisect for the largest in-bounds move toward target.
      let lo = current;
      let hi = target;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (tryMove(mid)) lo = mid;
        else hi = mid;
      }
      result = tryMove(lo);
      flashBlocked(name);
    }
    if (result) setValues(result);
  };

  const toggleLock = (name) => {
    setLocked(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const reset = () => {
    setValues(Object.fromEntries(ALL.map(k => [k, INITIAL])));
    setLocked(Object.fromEntries(ALL.map(k => [k, false])));
  };

  return (
    <div className="tradeoffs-page">
      <header className="tradeoffs-header">
        <button className="btn" onClick={onBack}>← Back</button>
        <h1>Tradeoffs</h1>
        <button className="btn" onClick={reset}>Reset</button>
      </header>

      <div className="tradeoffs-body">
        <p className="tradeoffs-intro">
          Lock the variables you want to hold constant. Move a slider to see what gives.
          Assumes values stay in a reasonable range — at extremes, real-world efficiency
          losses (slip, hull-speed spikes, technique breakdown) start to dominate and
          aren't modeled here.
        </p>

        <div className="tradeoffs-grid">
          <div className="tradeoffs-section">
            <h2>Stroke</h2>
            {STROKE.map(name => (
              <SliderRow
                key={name}
                name={name}
                value={values[name]}
                locked={locked[name]}
                blocked={blocked === name}
                onChange={(v) => handleSliderChange(name, v)}
                onToggleLock={() => toggleLock(name)}
              />
            ))}
          </div>

          <div className="tradeoffs-section">
            <h2>Rigging</h2>
            {RIGGING.map(name => (
              <SliderRow
                key={name}
                name={name}
                value={values[name]}
                locked={locked[name]}
                blocked={blocked === name}
                onChange={(v) => handleSliderChange(name, v)}
                onToggleLock={() => toggleLock(name)}
              />
            ))}
            <DerivedBar
              label={LABELS.bladeLength}
              value={computeBladeLength(values)}
              desc={DESCRIPTIONS.bladeLength}
            />
          </div>
        </div>

      </div>
    </div>
  );
}

function DerivedBar({ label, value, desc }) {
  const pct = Math.max(0, Math.min(100, ((value - MIN) / (MAX - MIN)) * 100));
  return (
    <div className="slider-row is-derived" title={desc}>
      <div className="slider-row-top">
        <span className="derived-tag">derived</span>
        <span className="slider-label">{label}</span>
      </div>
      <div className="derived-bar">
        <div className="derived-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SliderRow({ name, value, locked, blocked, onChange, onToggleLock }) {
  return (
    <div
      className={`slider-row${locked ? ' is-locked' : ''}${blocked ? ' is-blocked' : ''}`}
      title={DESCRIPTIONS[name]}
    >
      <div className="slider-row-top">
        <button
          type="button"
          className={`lock-btn${locked ? ' is-locked' : ''}`}
          onClick={onToggleLock}
          aria-pressed={locked}
          aria-label={locked ? 'Unlock' : 'Lock'}
        >
          <LockIcon locked={locked} />
        </button>
        <span className="slider-label">{LABELS[name]}</span>
      </div>
      <input
        type="range"
        min={MIN}
        max={MAX}
        step="0.1"
        value={value}
        disabled={locked}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="tradeoff-slider"
      />
    </div>
  );
}

function LockIcon({ locked }) {
  return locked ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-3.1 0H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z" />
    </svg>
  );
}
