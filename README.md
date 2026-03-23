# Free Speed Calculator

An interactive rowing tool for visualizing how intra-stroke velocity variation costs energy — and race time.

Live at **https://free-speed.vercel.app**

## What it does

Two rowers at identical average speeds can require very different amounts of energy, because drag power scales as v³. Any speed variation within a stroke forces the rower to "buy back" lost ground at exponentially higher cost.

This tool lets you draw a boat speed profile for Rower B, automatically normalizes it to match Rower A's average speed, and shows:
- How much extra energy Rower B's profile requires (%)
- How much slower Rower B would finish given the same energy budget (seconds and metres)

## Physics

```
P(t) = k · v(t)³        drag power at instantaneous velocity
E = ∫ P(t) dt           energy per stroke
T_B = T_A × (P̄_B / P̄_A)^(1/3)   equivalent finish time
```

Because v³ is convex, Jensen's inequality guarantees that any speed variation increases mean power above the minimum required to sustain that average speed. See the [math page](https://free-speed.vercel.app/math.html) for full derivations.

## Features

- **Draw** a velocity profile by clicking and dragging on the chart
- **Save** curves to browser localStorage with a name and description
- **Share** curves via URL — all data is encoded in the hash fragment, no server needed
- **Examples** — pre-loaded technique faults (Micro Pause, Slow Catch, No Ratio) to explore

## Stack

- React 18 + Vite
- Chart.js / react-chartjs-2
- chartjs-plugin-annotation

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

## Project structure

```
src/
├── components/
│   ├── SpeedChart.jsx          # Interactive dual-curve chart
│   ├── BoatVisualization.jsx   # Finish-line gap visualization
│   ├── CurveHeader.jsx         # Name, description, save, share
│   └── SavedCurves.jsx         # Left nav — examples + saved curves
├── utils/
│   ├── physics.js              # P=kv³, energy, finish-time estimate
│   ├── curves.js               # Normalization
│   └── landmarks.js            # Stroke phase detection
├── data/
│   └── referenceCurve.json     # Reference speed profile (good technique)
├── App.jsx
└── App.css
public/
└── math.html                   # Mathematical background
```

## References

- Kleshnev, V. (2016). *The Biomechanics of Rowing*. Crowood Press.
- Hofmijster, M. J. et al. (2007). Effect of stroke rate on the distribution of net mechanical power in rowing. *Journal of Sports Sciences*.
