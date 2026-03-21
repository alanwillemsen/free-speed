# Problem Statement: Dynamic Energy-Equivalence Modeling for Rowing Velocity Variation

## 1. Project Title
**Dynamic Energy-Equivalence Modeling for Rowing Velocity Variation**

## 2. Problem Description
Standard rowing performance analysis often relies on average velocity ($V_{avg}$) to compare athletes. However, due to the non-linear relationship between fluid drag and velocity—where drag increases with the square of velocity ($D \propto v^2$) and power required increases with the cube ($P \propto v^3$)—two rowers with identical average speeds can have vastly different metabolic costs. 

Currently, there is no accessible tool that allows coaches or athletes to visualize specific intra-stroke velocity-time curves and quantitatively compare the "energy penalty" caused by velocity fluctuations (commonly known as "boat check") throughout a single stroke cycle.

## 3. Objective
To develop a computational system that enables users to:
1.  **Visualize** intra-stroke velocity fluctuations by drawing or importing speed curves.
2.  **Normalize** performance by translating a "test" curve (Curve B) to match the mean velocity ($V_{avg}$) of a "reference" curve (Curve A).
3.  **Quantify** the total energy expenditure ($E = \int P \, dt$) for both scenarios, specifically isolating the energy lost to the $v^3$ penalty.
4.  **Predict** "Equivalent Finish Times" for a 2km race by calculating the theoretical velocity of Curve B when constrained to the same total energy budget ($x$) as a known performance of Curve A.

---

## 4. Physics & Estimation Framework

### The Energy-Power Relationship
The power required to overcome water resistance is proportional to the cube of the instantaneous velocity:
$$P(t) = k \cdot v(t)^3$$
where $k$ is a constant representing the boat's drag coefficient and water density.

### Total Energy Calculation
For a rower finishing a 2km race in 7 minutes (420 seconds) using total energy $x$:
$$x = \int_{0}^{420} k \cdot v_A(t)^3 \, dt$$

### Normalizing Curve B
To compare Curve B, the system shifts the curve so its average velocity matches Curve A ($V_{avg} \approx 4.76 \, m/s$). Because of the cubic relationship, if Curve B has a higher "peak-to-trough" variance (less efficient), its average power will be higher than Curve A's, even if their average speed is identical.

### Estimating Finish Time
If the rower uses the **same** energy $x$ but follows the efficiency profile (shape) of Curve B:
1.  We find a scaling factor $c$ such that: $x = \int_{0}^{T} k \cdot (c \cdot v_B(t))^3 \, dt$
2.  **Result:** If Curve B is less efficient (more fluctuation), the rower must lower their overall speed to stay within the energy budget, resulting in a finish time $T > 7:00.0$.

The estimated finish time for Curve B is:
$$T_B = T_A \times \left( \frac{\text{Mean Power}_B}{\text{Mean Power}_A} \right)^{1/3}$$

---
**Answer**
The final result of the estimation is that a rower following the less efficient Curve B profile will result in a **slower finish time** (greater than 7 minutes) when constrained to the same total energy expenditure $x$.
