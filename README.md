# Dynamic Energy-Equivalence Modeling for Rowing Velocity Variation

An interactive web application for analyzing intra-stroke velocity fluctuations in rowing and quantifying their energy penalties. This tool enables coaches and athletes to visualize how "boat check" (velocity variation during the stroke cycle) affects metabolic cost and race performance.

## Problem Statement

Standard rowing performance analysis relies on average velocity (V_avg) to compare athletes. However, due to the non-linear relationship between fluid drag and velocity—where power increases with the cube of velocity (P ∝ v³)—two rowers with identical average speeds can have vastly different metabolic costs.

This application provides an accessible tool to:
1. Visualize intra-stroke velocity-time curves
2. Normalize test curves to match reference performance
3. Quantify energy penalties from velocity fluctuations
4. Predict equivalent finish times under same energy budgets

## Physics Foundation

### Power-Velocity Relationship
```
P(t) = k · v(t)³
```
Where:
- P(t) = power required at time t
- k = drag coefficient constant
- v(t) = instantaneous velocity

### Total Energy Calculation
```
E = ∫ P(t) dt = ∫ k · v(t)³ dt
```

### Finish Time Estimation
When comparing two curves with the same energy budget:
```
T_B = T_A × (P̄_B / P̄_A)^(1/3)
```

Where:
- T_A, T_B = finish times for curves A and B
- P̄_A, P̄_B = average power for curves A and B

## Features

### Core Functionality
- **Reference Curve (Curve A)**: Loaded from measured data (`Speed Curve.xlsx`)
- **Test Curve (Curve B)**: Interactive drawing interface for creating alternative velocity profiles
- **Automatic Normalization**: Scales Curve B to match Curve A's average velocity
- **Energy Analysis**: Calculates and compares total energy expenditure
- **Finish Time Prediction**: Estimates race time impact under equal energy budgets

### Visualizations
- Dual-curve chart with phase landmarks
- Interactive curve editing (click and drag)
- Real-time statistical comparison
- Energy penalty quantification
- Contextual insights and warnings

## Getting Started

### Prerequisites
- Node.js 18+ and npm

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```
Open http://localhost:5173/ in your browser.

### Build for Production
```bash
npm run build
```

## Usage Guide

### 1. Load Reference Data
Curve A (reference) is automatically loaded from `Speed Curve.xlsx`. This represents actual measured boat velocity during one stroke cycle.

### 2. Draw Test Curve
Click and drag on the chart to modify Curve B. Try creating profiles with:
- Greater velocity variation (more "boat check")
- Smoother, steadier velocity
- Different acceleration patterns

### 3. Normalize and Compare
Click "Normalize Curve B to Match Curve A" to scale your test curve to the same average velocity. This enables fair energy comparison.

### 4. Analyze Results
View the energy analysis to see:
- Energy per stroke for both curves
- Energy penalty (% increase due to variation)
- Predicted finish time under same energy budget
- Statistical comparison of velocity patterns

## Key Insights

### Why Does Variation Matter?
Because power scales as v³, periods of high velocity cost exponentially more energy than they save during low-velocity periods. Example:

**Constant velocity:** v = 5 m/s
- Power = k × 5³ = 125k

**Variable velocity:** v alternates between 4 and 6 m/s (same average: 5 m/s)
- Average power = k × (4³ + 6³)/2 = k × (64 + 216)/2 = 140k
- **12% more energy despite same average speed!**

### Practical Applications
- **Technique optimization**: Identify stroke patterns that minimize boat check
- **Coaching tool**: Demonstrate energy cost of inefficient technique
- **Performance prediction**: Estimate time savings from improved velocity profiles
- **Athlete education**: Visual understanding of power-velocity relationship

## Data Format

### Reference Curve (Speed Curve.xlsx)
The Excel file contains:
- **Time (sec)**: Timestamps within one stroke cycle
- **Boat Speed (m/s)**: Measured velocity at each time point
- **Phase Landmark**: Key stroke phases (ENTRY, EXTRACTION, etc.)

Sample data structure:
```
Time | Speed | Landmark
4.10 | 5.10  | FULL REACH (Start)
4.30 | 3.95  | ENTRY
4.60 | 4.90  | OAR PERPENDICULAR
4.85 | 5.40  | EXTRACTION
...
```

## Technical Architecture

### Stack
- **Framework**: React 18 with Hooks
- **Build Tool**: Vite 5
- **Charting**: Chart.js + react-chartjs-2
- **Data Processing**: Custom physics engine
- **Styling**: Custom CSS with responsive design

### Project Structure
```
src/
├── components/
│   ├── SpeedChart.jsx      # Interactive dual-curve visualization
│   ├── Controls.jsx        # Curve manipulation and statistics
│   └── Results.jsx         # Energy analysis and predictions
├── utils/
│   ├── physics.js          # Power/energy calculations (P=kv³)
│   └── curves.js           # Curve normalization and manipulation
├── data/
│   └── referenceCurve.json # Extracted from Speed Curve.xlsx
├── App.jsx                 # Main application logic
├── App.css                 # Styling
└── main.jsx                # Entry point
```

### Key Algorithms

**Energy Integration** (Trapezoidal Rule):
```javascript
E = Σ [(P(t_i) + P(t_{i+1})) / 2] × Δt
```

**Curve Normalization**:
```javascript
v_normalized = v_original × (V̄_target / V̄_current)
```

**Finish Time Estimation**:
```javascript
T_B = T_A × (P̄_B / P̄_A)^(1/3)
```

## Example Scenarios

### Scenario 1: Steady Rower
- **Curve A**: Reference data (avg: 5.21 m/s, range: 2.40 m/s)
- **Curve B**: Draw flatter curve (avg: 5.21 m/s, range: 1.50 m/s)
- **Result**: ~5-8% energy reduction → ~2-3 seconds faster finish

### Scenario 2: "Boat Check" Problem
- **Curve A**: Reference data
- **Curve B**: Draw exaggerated peaks and troughs (avg: 5.21 m/s, range: 3.50 m/s)
- **Result**: ~15-25% energy penalty → ~5-8 seconds slower finish

## Race Parameters

Fixed for standard 2km race:
- **Distance**: 2000 meters
- **Reference Time**: 7:00.0 (420 seconds)
- **Stroke Duration**: ~1.55 seconds (from data)
- **Total Strokes**: ~270 strokes

## Scientific Background

This tool is based on established principles of fluid dynamics and biomechanics in rowing:

1. **Drag Force**: F_drag = ½ρ C_d A v² (simplified to k·v² in our model)
2. **Power Requirement**: P = F × v = k·v³
3. **Energy Minimization**: For fixed average velocity, constant speed minimizes total energy
4. **Metabolic Efficiency**: Reduced energy expenditure allows higher sustainable power output

## Limitations

- **Simplified drag model**: Uses k·v³ rather than full fluid dynamics
- **No rigging effects**: Assumes identical boat/oar setup
- **Constant stroke rate**: Doesn't model stroke rate variations
- **Ideal conditions**: Ignores wind, waves, water temperature
- **Single stroke analysis**: Extrapolates one stroke cycle to full race

## Contributing

This is an educational and analytical tool. Suggested improvements:
- Multi-stroke analysis with fatigue modeling
- Integration with real-time GPS/accelerometer data
- Comparison database of elite vs. novice profiles
- Variable stroke rate modeling
- Wind/current compensation

## License

ISC

## Acknowledgments

- Physics model based on rowing biomechanics literature
- Reference data from Speed Curve.xlsx (measured boat velocity)
- Built for coaches, athletes, and sports scientists

## References

For more information on rowing physics and efficiency:
- "The Physics of Rowing" - Atkinson (1982)
- "Rowing Biomechanics" - Kleshnev (2016)
- "Power and Efficiency in Rowing" - Hofmijster et al. (2007)

---

**Note**: This tool is for educational and analytical purposes. Actual race performance depends on numerous factors beyond velocity profiles including athlete fitness, technique, environmental conditions, and equipment.
