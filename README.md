# Rowing Speed Curve Analysis

An interactive web application that analyzes rowing speed curves using fluid dynamics principles. Visualize how hull speed variations during a stroke cycle affect energy expenditure.

## Physics Principles

The application is based on the fundamental relationship in fluid dynamics:

- **Drag Force**: F = k × v² (simplified)
- **Power Required**: P = F × v = k × v³
- **Energy per Stroke**: E = ∫ P dt

Due to the cubic relationship between power and velocity, varying speed requires more energy than maintaining constant velocity for the same average speed.

## Features

- Interactive speed curve editor (click and drag to modify)
- Real-time energy calculations
- Comparison between optimal and user-defined curves
- Parametric controls for stroke rate, race distance, and target time
- Visual phase annotations (Drive/Recovery phases)
- Energy budget analysis and finish time predictions

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

### Build

```bash
npm run build
```

The production-ready files will be in the `dist` directory.

## Usage

1. **Adjust Parameters**: Use the sidebar controls to set stroke rate, race distance, and target finish time
2. **Modify Speed Curve**: Click and drag on the chart to create different speed profiles
3. **Analyze Results**: View energy differences and finish time predictions below the chart
4. **Reset**: Click "Reset to Optimal Curve" to return to the baseline

## How It Works

The application calculates energy expenditure by integrating power over the stroke cycle. The optimal curve represents minimal speed variation, while user-drawn curves show how deviations increase energy requirements.

### Key Insights

- **Constant speed is most efficient**: Minimizing speed variation reduces total energy
- **Speed variation is expensive**: Due to P = k·v³, higher speeds cost exponentially more
- **Practical constraints**: Real rowing involves necessary speed variations, but minimizing them improves efficiency

## Technical Details

- **Framework**: React 18 + Vite
- **Charting**: Chart.js with react-chartjs-2
- **Physics Engine**: Custom integration of simplified fluid dynamics
- **Responsive Design**: Works on desktop and tablet devices

## Project Structure

```
free-speed/
├── src/
│   ├── components/
│   │   ├── Parameters.jsx      # Race parameter controls
│   │   ├── SpeedChart.jsx       # Interactive chart with drawing
│   │   └── Results.jsx          # Energy analysis display
│   ├── utils/
│   │   ├── physics.js           # Energy/power calculations
│   │   └── curves.js            # Curve generation/manipulation
│   ├── App.jsx                  # Main application component
│   ├── App.css                  # Styling
│   └── main.jsx                 # Entry point
├── index.html
├── package.json
└── vite.config.js
```

## License

ISC

## Acknowledgments

Based on principles of fluid dynamics and rowing biomechanics.
