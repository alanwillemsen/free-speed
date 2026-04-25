# LiveCapture — Technical Documentation

## Overview

`LiveCapture` is a React component that turns a smartphone into a real-time rowing stroke analyser. It reads the device accelerometer at ~60 Hz via the [DeviceMotion API](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent), automatically detects phone orientation and individual stroke boundaries, reconstructs a boat-speed curve for each stroke, and builds a running average that can be exported to the main calculator.

When GPS is available, the speed curve is anchored to real m/s values. Otherwise it falls back to a relative (shape-only) mode.

---

## Pipeline at a Glance

```
Accelerometer (60 Hz) + DeviceOrientation (gravity)
  → Gravity compensation (subtract g from accelerationIncludingGravity)
  → Auto-orientation calibration (3 s variance analysis)
  → Axis selection & sign flip
  → Noise-reduction EMA filter
  → Stroke-boundary EMA filter → zero-crossing detector
  → Per-stroke processing:
      Trapezoidal integration
        → [GPS available] Linear regression anchoring to absolute m/s
        → [No GPS]        Drift removal → Min-max scaling to reference range
      → Resampling to 33 uniform phase points
  → Rolling average across strokes
  → [No GPS] Mean-match scaling on save
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

### 2.1 Axis Detection via Variance

During calibration, gravity-compensated acceleration samples are accumulated on all three axes. After 3 seconds, the variance of each axis is computed:

$$\sigma^2_{\text{axis}} = \frac{1}{N}\sum_{i=1}^{N}(a_i - \bar{a})^2$$

The axis with the highest variance between `x` and `y` is the boat-forward axis (rowing produces the largest acceleration signal along the direction of travel; `z` is vertical and ignored):

$$\text{forward axis} = \arg\max(\sigma^2_x,\; \sigma^2_y)$$

If no axis exceeds a minimum variance threshold ($\sigma^2 < 0.5\;\text{m}^2/\text{s}^4$), calibration is extended until meaningful motion is detected.

### 2.2 Sign Detection

The sign (which direction along the axis is "toward the bow") is determined by the single largest absolute acceleration spike during calibration — this corresponds to the drive phase, which is the forward (bow-ward) direction:

$$\text{sign} = \text{sgn}\bigl(a_{\text{axis}}[k^*]\bigr), \qquad k^* = \arg\max_i |a_{\text{axis}}[i]|$$

### 2.3 Calibration Lifecycle

| Status | Meaning |
|---|---|
| `idle` | Not yet capturing |
| `calibrating` | Accumulating samples, waiting for motion |
| `detected` | Axis and sign locked; stroke processing begins |

No stroke processing occurs during calibration. Once locked, the detected orientation is displayed (e.g. "Portrait — top toward bow").

---

## 3. Signal Filtering

Two exponential moving average (EMA) filters run in parallel on every sample (after calibration completes).

### 3.1 Noise-Reduction Filter

A light EMA smooths high-frequency vibration for the recorded signal:

$$\hat{a}(t) = \hat{a}(t{-}1) + \alpha_n \bigl(a_{\text{raw}}(t) - \hat{a}(t{-}1)\bigr)$$

with $\alpha_n = 0.4$.

This filtered value $\hat{a}(t)$ is what gets stored in the sample buffer and later integrated into velocity.

### 3.2 Stroke-Boundary Detection Filter

A much heavier (slower) EMA tracks the low-frequency trend for stroke segmentation:

$$\bar{a}(t) = \bar{a}(t{-}1) + \alpha_s \bigl(a_{\text{raw}}(t) - \bar{a}(t{-}1)\bigr)$$

with $\alpha_s = 0.06$.

**Full reach** (the stroke boundary) is detected when this signal crosses zero from above:

$$\bar{a}(t{-}1) \geq 0 \quad \text{and} \quad \bar{a}(t) < 0$$

Full reach is the moment the rower reaches maximum forward extension on the slide. Up to this point, the rower decelerating at front stops transfers momentum to the boat ("free speed"). After full reach, the boat decelerates under drag alone until the catch (blade entry), where the boat reaches its minimum speed.

The crossing is accepted as a valid stroke boundary only if the elapsed time since the previous boundary falls within:

$$800\;\text{ms} \;\leq\; \Delta t \;\leq\; 4000\;\text{ms}$$

This corresponds to a stroke-rate range of roughly 15–75 spm, rejecting spurious crossings.

---

## 4. Per-Stroke Processing

Once a valid stroke is delimited (all buffered samples between two consecutive catches), the following pipeline converts raw acceleration into a speed curve.

### 4.1 Numerical Integration (Acceleration → Velocity)

Velocity is reconstructed from acceleration by trapezoidal integration:

$$v(t_0) = 0$$

$$v(t_i) = v(t_{i-1}) + \frac{\hat{a}(t_{i-1}) + \hat{a}(t_i)}{2}\;\Delta t_i$$

where $\Delta t_i = t_i - t_{i-1}$ (in seconds).

This yields a **relative** velocity curve — the absolute boat speed is unknown because the integration constant is arbitrary and accelerometer bias / sensor drift accumulate.

### 4.2a GPS-Anchored Mode (`processStrokeWithGPS`)

When GPS speed readings are available (from `Geolocation.watchPosition` at ~1 Hz), they are used to anchor the integrated velocity to real m/s values, replacing drift removal and min-max scaling entirely.

**Step 1 — Find relevant GPS readings.** All GPS speed samples within ±500 ms of the stroke window $[t_0, t_N]$ are collected.

**Step 2 — Compute offsets.** For each GPS reading at time $t_g$ with speed $v_{\text{GPS}}$, the integrated velocity is interpolated at $t_g$ and the offset is:

$$\delta(t_g) = v_{\text{GPS}}(t_g) - v_{\text{integrated}}(t_g)$$

**Step 3 — Linear regression.** A linear correction $\delta(t) = a + bt$ is fitted to the offsets:

- With 1 GPS point: constant offset ($a = \delta$, $b = 0$)
- With 2+ GPS points: ordinary least-squares linear fit

$$b = \frac{n\sum t_g \delta_g - \sum t_g \sum \delta_g}{n\sum t_g^2 - (\sum t_g)^2}, \qquad a = \frac{\sum \delta_g - b \sum t_g}{n}$$

**Step 4 — Apply correction.** The anchored velocity at each sample is:

$$v_{\text{anchored}}(t_i) = v_{\text{integrated}}(t_i) + a + b \cdot t_i$$

This simultaneously corrects for the unknown integration constant (via $a$) and linear drift (via $b$), producing a curve in real m/s.

**Fallback:** If no GPS readings fall within the stroke window, or if the anchored speeds are physically unreasonable ($\min < -1\;\text{m/s}$), the stroke falls back to relative mode.

### 4.2b Relative Mode (`processStroke`)

When GPS is unavailable (indoor rowing, erg, no GPS lock), the original processing pipeline is used.

**Linear Drift Removal.** Integration drift manifests as a linear ramp. Because a single stroke is periodic ($v$ at the start ≈ $v$ at the end), we enforce this by subtracting a linear trend:

$$d = \frac{v(t_N) - v(t_0)}{N - 1}$$

$$v'(t_i) = v(t_i) - d \cdot i$$

**Min-Max Scaling.** The detrended velocity is scaled to match the reference curve's amplitude:

$$v_{\text{scaled}}(t_i) = v_{\text{ref,min}} + \frac{v'(t_i) - \min(\mathbf{v'})}{\max(\mathbf{v'}) - \min(\mathbf{v'})} \cdot (v_{\text{ref,max}} - v_{\text{ref,min}})$$

This preserves the **shape** of the curve while discarding absolute magnitude.

### 4.3 Resampling to Uniform Phase

Raw samples are unevenly spaced in time. They are resampled onto a uniform grid of $N = 33$ points spanning the normalised stroke phase $\phi \in [0, 1]$ via **linear interpolation**:

For each target phase point $\phi_k = \frac{k}{N-1}$, find the bracketing raw timestamps $t_j \leq t(\phi_k) < t_{j+1}$ and interpolate:

$$v_k = v_{\text{src}}(t_j) + \frac{t(\phi_k) - t_j}{t_{j+1} - t_j} \bigl(v_{\text{src}}(t_{j+1}) - v_{\text{src}}(t_j)\bigr)$$

The last point is then forced equal to the first ($v_{N-1} := v_0$) to guarantee a seamless periodic curve.

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
| `NOISE_ALPHA` | 0.4 | EMA smoothing for recorded signal |
| `STROKE_DETECT_ALPHA` | 0.06 | EMA smoothing for catch detection |
| `MIN_STROKE_MS` | 800 ms | Minimum stroke duration |
| `MAX_STROKE_MS` | 4000 ms | Maximum stroke duration |
| `MAX_STROKES` | 20 | Rolling average window |
| `UI_UPDATE_MS` | 250 ms | React state sync interval |
| `CALIBRATION_MS` | 3000 ms | Auto-orientation calibration window |

---

## 10. Architecture Notes

- **Refs over state**: All 60 Hz processing state lives in `procRef` to avoid stale closures and unnecessary React re-renders. React state is synced from refs every 250 ms for display only.
- **Wake Lock**: A `navigator.wakeLock` request keeps the screen on during capture.
- **iOS permissions**: On Safari, both `DeviceMotionEvent.requestPermission()` and `DeviceOrientationEvent.requestPermission()` must be called from a user gesture. GPS permission is requested implicitly by the browser on first `watchPosition` call.
- **Buffer management**: The sample buffer is trimmed to the last 5 seconds on every catch detection. GPS speeds are trimmed to the last 30 seconds.
- **Graceful degradation**: Each sensor enhancement is independent. If `DeviceOrientation` is unavailable, gravity compensation is skipped. If GPS is unavailable, relative mode is used. The component works with just the accelerometer alone.
