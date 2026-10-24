# LiveCapture — Technical Documentation

## Overview

`LiveCapture` is a React component that turns a smartphone into a real-time rowing stroke analyser. It reads the device accelerometer at ~60 Hz via the [DeviceMotion API](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent), automatically detects phone orientation and individual stroke boundaries, reconstructs a boat-speed curve for each stroke, and builds a running average that can be exported to the main calculator.

When GPS is available, the speed curve is anchored to real m/s values. Otherwise it falls back to a relative (shape-only) mode.

---

## Pipeline at a Glance

```
Accelerometer (60 Hz) + DeviceOrientation (gravity)
  → Gravity compensation (device linear acceleration, or g subtracted from accelerationIncludingGravity)
  → Auto-orientation calibration (6 s): principal axis = fore-aft; bow sign from the skewness
  → Continuous axis tracking (5 s window) + bow-sign evidence (15 s skewness, persistence-gated flip)
  → Surge acceleration = projection onto the signed axis
  → Unified speed signal: integrate → 5 s high-pass = `rel` (the rolling-graph trace)
      → + slow GPS-anchored level = `abs` (instantaneous m/s)
  → Catch detection: local minimum of the 200 ms-smoothed speed (prominence hysteresis),
      placed at the true minimum of `rel`
  → Per-stroke: slice `abs`/`rel` catch → catch, mean speed (split), 33-pt resample (free speed)
  → Rolling average across strokes
```

---

## 1. Gravity Compensation

Many Android devices return `null` for `event.acceleration` (hardware gravity-subtracted). As a fallback, the component listens to `DeviceOrientationEvent` for tilt angles and manually subtracts gravity from `accelerationIncludingGravity`.

Given device tilt angles $\beta$ (front-back) and $\gamma$ (left-right) in degrees, the gravity vector in device coordinates is:

$$g_x = g \sin(\gamma)$$

$$g_y = g \sin(\beta) \cos(\gamma)$$

$$g_z = g \cos(\beta) \cos(\gamma)$$

where $g = 9.81\;\text{m/s}^2$. The corrected acceleration is:

$$a_{\text{axis}} = a_{\text{raw,axis}} - g_{\text{axis}}$$

When `event.acceleration` is available (good iOS, some Android), it is used directly and this step is skipped.

---

## 2. Auto-Orientation Detection

Instead of a manual dropdown, orientation is detected automatically during a 3-second calibration window at the start of each capture.

### 2.1 Axis Detection

During calibration, gravity-compensated acceleration samples are accumulated on all three axes. After 6 s the fore-aft (surge) axis is taken as the principal axis of the acceleration cloud — the dominant eigenvector of the 3×3 covariance (power iteration), as a free 3D unit vector. Rowing produces by far the largest acceleration along the direction of travel, so no assumption about how the phone is mounted is needed.

If the dominant variance is below $0.5\;\text{m}^2/\text{s}^4$ there is no real motion yet and calibration restarts. After calibration the axis is re-estimated every second over a 5 s rolling window; a jump beyond 35° that persists for 2.5 s is treated as a remount and the speed signal restarts on the new axis.

### 2.2 Bow Sign — which way along the axis is forward

The principal axis is unsigned, so the bow direction has to be read from the *shape* of the acceleration. A hull's surge acceleration is **negatively skewed along the bow**: the catch check — the crew's momentum reversing and the blades entering — is a sharp, large deceleration spike, while the drive is a broader, lower hump (Kleshnev's boat-acceleration curves show this in every class; it measures −1.0…−1.3 in our recorded rows, and reads the right way in 99–100% of 8 s windows while rowing).

$$\text{skew} = \frac{\tfrac{1}{N}\sum (a_i - \bar a)^3}{\bigl(\tfrac{1}{N}\sum (a_i - \bar a)^2\bigr)^{3/2}}, \qquad \text{sign} : \text{skew}(a \cdot \hat d) < 0$$

The earlier rule — "the single largest acceleration spike is the drive, hence forward" — got this backwards, because the largest spike *is* the catch. It inverted every curve: a slow rise, a sharp jump and a decline instead of the hull's sharp catch drop, drive climb and recovery decline.

**Evidence and flipping.** After calibration the sign is tracked continuously: the surge projection is smoothed (~3 Hz; vibration is symmetric noise that only dilutes the skewness) and fed into exponentially weighted running moments with a 15 s window. If the skewness sits beyond +0.5 (i.e. the "bow" is really the stern) for 5 s without interruption, the axis is negated and the speed integrator restarted. Evidence is only accumulated while the boat is moving in the rowing band (GPS 4:00–1:00 /500 m when GPS is present; otherwise the variance gate below) — the rule's rare misses are at rest and during handling.

**Manual backstop.** The ⇅ button on the stroke chart and the full-screen readout flips the axis by hand and pins it for the rest of the capture. A linked coach is re-sent the direction, and adopts it with its own evidence reset.

**Re-estimation never flips.** The 5 s rolling re-estimate of the axis is kept continuous with the previous direction (dot product ≥ 0); only the skewness evidence, a remount snap (which re-reads the sign on the new axis) or the user can change the sign.

### 2.3 Calibration Lifecycle

| Status | Meaning |
|---|---|
| `idle` | Not yet capturing |
| `calibrating` | Accumulating samples, waiting for motion |
| `detected` | Axis and sign locked; stroke processing begins |

No stroke processing occurs during calibration. Once locked, the detected orientation is displayed (e.g. "Portrait — top toward bow").

---

## 3. Unified Boat-Speed Signal

One continuous surge-speed signal drives the rolling graph, catch detection, stroke rate, split and free speed.

**Integration.** The surge acceleration $a(t)$ (projection onto the signed axis) is integrated sample by sample:

$$v(t_i) = v(t_{i-1}) + a(t_i)\,\Delta t_i$$

**Drift high-pass.** Raw integration wanders (any residual bias ramps without bound), so a slow baseline is subtracted:

$$b(t_i) = b(t_{i-1}) + \bigl(1 - e^{-\Delta t_i/\tau_{hp}}\bigr)\bigl(v(t_i) - b(t_{i-1})\bigr), \qquad \text{rel}(t) = v(t) - b(t)$$

with $\tau_{hp} = 5$ s — well above a stroke period, so the stroke-rate oscillation passes through (gain 0.99, phase ≈ 7° at 16 spm) while the runaway DC term is dropped. `rel` is relative m/s about the local mean and **is** the rolling-graph trace.

**GPS level.** When a recent GPS Doppler speed $g(t)$ is available (interpolated; a fix older than 3 s is ignored), a slowly varying level anchors the absolute speed:

$$\ell(t_i) = \ell(t_{i-1}) + \bigl(1 - e^{-\Delta t_i/\tau_\ell}\bigr)\bigl(g(t_i) - \text{rel}(t_i) - \ell(t_{i-1})\bigr), \qquad \text{abs}(t) = \text{rel}(t) + \ell(t)$$

with $\tau_\ell = 12$ s $> \tau_{hp}$, so the level only ever carries low-frequency content: the within-stroke shape comes from the IMU alone (1 Hz GPS cannot resolve it and the phone's GPS speed is itself smoothed), the magnitude from GPS.

---

## 4. Catch Detection and Per-Stroke Processing

### 4.1 Catch detection

The catch is the boat's slowest point — the local **minimum** of speed where the catch deceleration turns into the drive. `rel` is smoothed with a 200 ms exponential filter and run through an alternating peak/valley tracker with 0.15 m/s prominence hysteresis: in *seekMin* the descending signal is followed to its lowest point; once it has climbed back 0.15 m/s the low was a catch, and the tracker flips to *seekMax* to find the following peak before the next descent. Strict alternation gives exactly one catch per cycle.

The smoother lags the speed by about its time constant, so the catch is **placed at the true minimum of `rel`** within the 600 ms behind the smoothed valley — not at the valley's own timestamp (which put the minimum at phase ≈ 0.93 of the previous stroke).

A catch is accepted as a stroke boundary only if the time since the previous one is within 800 ms … 4000 ms (15–75 spm).

### 4.2 Per-stroke values

For the slice of the unified signal between consecutive catches:

- **Split** = mean of `abs` over the stroke (GPS-accurate in magnitude, IMU-smooth), null without a GPS anchor.
- **Curve** = the slice resampled to 33 uniform phase points (`abs` when anchored, `rel` otherwise), with the last point forced equal to the first. Used for the free-speed number; the rolling graph draws the full-rate signal, not this.
- **Attitude** = p5–p95 roll/pitch swing from the gravity vector.

Recording is gated on the rowing band: the GPS speed smoothed over max(stroke, 5 s) must lie within 2.08–8.33 m/s (4:00–1:00 /500 m).

---

## 5. Rolling Average

Up to 20 most recent strokes are retained in a FIFO window. Their point-wise mean forms the displayed average curve:

$$\bar{v}_k = \frac{1}{M} \sum_{m=1}^{M} v_k^{(m)}, \qquad k = 0, \ldots, N{-}1$$

where $M = \min(\text{stroke count},\; 20)$.

This smooths out stroke-to-stroke variation and converges toward the rower's characteristic speed profile.

---

## 6. Stroke Rate Calculation

Up to 10 recent stroke-boundary (full reach) timestamps are kept. Stroke rate in strokes per minute is:

$$\text{spm} = \left\lfloor \frac{60{,}000}{\;\dfrac{t_{\text{last}} - t_{\text{first}}}{n - 1}\;} \right\rfloor$$

where $n$ is the number of stored catch times and the timestamps are in milliseconds.

---

## 7. GPS Speed Tracking

The component uses `navigator.geolocation.watchPosition` with `enableHighAccuracy: true` to receive ~1 Hz GPS speed updates. Each reading records:

- **Speed**: `coords.speed` in m/s (ground speed from GPS chipset)
- **Timestamp**: Converted from epoch to `performance.now()` timeline for alignment with accelerometer samples:

$$t_{\text{perf}} = \text{performance.now()} - (\text{Date.now()} - t_{\text{GPS epoch}})$$

GPS speeds are retained in a 30-second rolling buffer.

### GPS Status States

| Status | Meaning |
|---|---|
| `idle` | Not yet started |
| `requesting` | `watchPosition` called, awaiting first fix |
| `active` | Receiving GPS speed data |
| `unavailable` | Geolocation denied, unsupported, or no fix |

When `active`, strokes are processed with `processStrokeWithGPS` first, falling back to `processStroke` when no GPS reading coincides with a stroke window.

---

## 8. Save & Export

### GPS-Anchored Mode

When strokes were processed with GPS, the average curve already contains real m/s values and is passed through as-is to the calculator.

### Relative Mode

The average curve is rescaled so its mean speed matches the reference curve's mean, enabling fair energy comparison:

$$\bar{v}_{\text{cap}} = \frac{1}{N}\sum_{k} \bar{v}_k, \qquad \bar{v}_{\text{ref}} = \frac{1}{N}\sum_{k} v_{\text{ref},k}$$

$$v_{\text{export},k} = \bar{v}_k \cdot \frac{\bar{v}_{\text{ref}}}{\bar{v}_{\text{cap}}}$$

This uniform scaling preserves the curve shape while ensuring both curves represent the same average boat speed — the precondition for the calculator's energy-penalty and finish-time computations ($P \propto v^3$).

---

## 9. Constants Reference

| Constant | Value | Purpose |
|---|---|---|
| `NUM_POINTS` | 33 | Resampling grid size |
| `CALIBRATION_MS` | 6000 ms | Auto-orientation calibration window (> 1 stroke, so the bow sign reads) |
| `ORIENT_WINDOW_MS` | 5000 ms | Rolling window for the axis re-estimate |
| `ORIENT_SWITCH_DEG` | 35° | Axis jump beyond this = remount candidate |
| `SIGN_EVIDENCE_TAU_S` | 15 s | Running-moment window for the bow-sign skewness |
| `SIGN_MIN_SKEW` | 0.5 | Weaker skewness carries no opinion |
| `SIGN_FLIP_HOLD_MS` | 5000 ms | Opposite evidence must persist this long before a flip |
| `SURGE_HP_TAU_S` | 5 s | Drift high-pass on the integrated speed |
| `GPS_LEVEL_TAU_S` | 12 s | GPS absolute-level anchor |
| `VSMOOTH_TAU_S` | 0.2 s | Detection smoother |
| `CATCH_PROMINENCE` | 0.15 m/s | Peak↔valley hysteresis for a real catch |
| `CATCH_LOOKBACK_MS` | 600 ms | Search window behind the smoothed valley for the true minimum |
| `MIN_STROKE_MS` / `MAX_STROKE_MS` | 800 / 4000 ms | Stroke-duration bounds |
| `UI_UPDATE_MS` | 250 ms | React state sync interval |

---

## 10. Architecture Notes

- **Refs over state**: All 60 Hz processing state lives in `procRef` to avoid stale closures and unnecessary React re-renders. React state is synced from refs every 250 ms for display only.
- **Wake Lock**: A `navigator.wakeLock` request keeps the screen on during capture.
- **iOS permissions**: On Safari, both `DeviceMotionEvent.requestPermission()` and `DeviceOrientationEvent.requestPermission()` must be called from a user gesture. GPS permission is requested implicitly by the browser on first `watchPosition` call.
- **Buffer management**: The sample buffer is trimmed to the last 5 seconds on every catch detection. GPS speeds are trimmed to the last 30 seconds.
- **Graceful degradation**: Each sensor enhancement is independent. If `DeviceOrientation` is unavailable, gravity compensation is skipped. If GPS is unavailable, relative mode is used. The component works with just the accelerometer alone.
