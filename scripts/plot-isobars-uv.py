"""
Plot isobars (lines of constant pressure) in (u, v) space.
Like a topographic map showing pressure contours.
Zoomable and interactive.
"""

import numpy as np
import matplotlib.pyplot as plt
from iapws import IAPWS97
from pathlib import Path
import json

# Load saturation dome for reference
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
sat_u_f = np.array([pt['u_f'] for pt in sat_points])
sat_v_f = np.array([pt['v_f'] for pt in sat_points])
sat_u_g = np.array([pt['u_g'] for pt in sat_points])
sat_v_g = np.array([pt['v_g'] for pt in sat_points])
sat_P = np.array([pt['P_MPa'] for pt in sat_points])
sat_T = np.array([pt['T_K'] for pt in sat_points])

# Generate isobars
# For each pressure, trace the line in (u, v) space by varying T

print("Generating isobars...")

# Pressures to plot (MPa)
pressures = [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 15, 20, 22.064, 25, 30, 40, 50, 75, 100]

isobars = {}

for P in pressures:
    print(f"  P = {P} MPa")
    u_vals = []
    v_vals = []

    # Temperature range depends on pressure
    if P < 22.064:  # Below critical pressure
        # Find saturation temperature at this pressure
        # Approximate by interpolating sat_P -> sat_T
        idx = np.searchsorted(sat_P, P)
        if idx > 0 and idx < len(sat_P):
            t = (P - sat_P[idx-1]) / (sat_P[idx] - sat_P[idx-1])
            T_sat = sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])
        else:
            T_sat = 373 + 273.15  # Fallback

        # Liquid side: T from 273.16 to T_sat
        for T in np.linspace(273.16, T_sat - 0.1, 50):
            try:
                water = IAPWS97(T=T, P=P)
                if water.u is not None and water.v is not None:
                    u_vals.append(water.u)
                    v_vals.append(water.v)
            except:
                pass

        # Mark discontinuity (two-phase region)
        u_vals.append(np.nan)
        v_vals.append(np.nan)

        # Vapor side: T from T_sat to high T
        for T in np.linspace(T_sat + 0.1, 800 + 273.15, 50):
            try:
                water = IAPWS97(T=T, P=P)
                if water.u is not None and water.v is not None:
                    u_vals.append(water.u)
                    v_vals.append(water.v)
            except:
                pass
    else:
        # Supercritical - continuous
        for T in np.linspace(273.16, 800 + 273.15, 100):
            try:
                water = IAPWS97(T=T, P=P)
                if water.u is not None and water.v is not None:
                    u_vals.append(water.u)
                    v_vals.append(water.v)
            except:
                pass

    isobars[P] = (np.array(u_vals), np.array(v_vals))

print("Done generating isobars")

# Create figure
fig, ax = plt.subplots(figsize=(14, 10))

# Use log scale for v
ax.set_xscale('log')

# Plot saturation dome
dome_u = list(sat_u_f) + list(sat_u_g[::-1]) + [sat_u_f[0]]
dome_v = list(sat_v_f) + list(sat_v_g[::-1]) + [sat_v_f[0]]
ax.fill(dome_v, dome_u, alpha=0.2, color='red', label='Two-phase region')
ax.plot(sat_v_f, sat_u_f, 'r-', linewidth=2, label='Saturated liquid')
ax.plot(sat_v_g, sat_u_g, 'r--', linewidth=2, label='Saturated vapor')

# Plot isobars with color gradient
colors = plt.cm.viridis(np.linspace(0, 1, len(pressures)))

for (P, (u_vals, v_vals)), color in zip(isobars.items(), colors):
    label = f'{P} MPa' if P >= 1 else f'{P*1000:.0f} kPa'
    ax.plot(v_vals, u_vals, '-', color=color, linewidth=1.5, label=label)

    # Add pressure label at a point on the curve
    valid_mask = ~np.isnan(u_vals) & ~np.isnan(v_vals)
    if np.any(valid_mask):
        valid_u = u_vals[valid_mask]
        valid_v = v_vals[valid_mask]
        # Label near the middle of the curve
        mid_idx = len(valid_u) // 3
        if mid_idx < len(valid_u):
            ax.annotate(f'{P}', (valid_v[mid_idx], valid_u[mid_idx]),
                       fontsize=7, color=color, alpha=0.8)

ax.set_xlabel('Specific Volume v (m³/kg)', fontsize=12)
ax.set_ylabel('Internal Energy u (kJ/kg)', fontsize=12)
ax.set_title('Isobars (constant pressure lines) in (u, v) space\n'
             'Scroll to zoom, drag to pan', fontsize=12)

ax.set_xlim(0.0009, 200)
ax.set_ylim(-100, 3500)
ax.grid(True, alpha=0.3, which='both')
ax.legend(loc='upper left', fontsize=8, ncol=2)

# Enable interactive zoom/pan
plt.tight_layout()

print("\nPlot ready. Use scroll wheel to zoom, drag to pan.")
print("Close the window when done.")

plt.show()
