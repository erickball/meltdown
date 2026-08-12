"""
Interactive visualization of v10 (u, v) grid colored by pressure.
Hover over points to see exact u, v, T, P values.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load v13 data
data_path = Path(__file__).parent / 'uv_grid_data_v13.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} points")

# Load saturation dome (filtered)
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points_raw = dome_data['raw_data']
sat_points_data = [p for i, p in enumerate(sat_points_raw) if i != 274]

sat_u_f = np.array([pt['u_f'] for pt in sat_points_data])
sat_v_f = np.array([pt['v_f'] for pt in sat_points_data])
sat_u_g = np.array([pt['u_g'] for pt in sat_points_data])
sat_v_g = np.array([pt['v_g'] for pt in sat_points_data])

dome_u = list(sat_u_f) + list(sat_u_g[::-1])
dome_v = list(sat_v_f) + list(sat_v_g[::-1])

# Extract arrays
u = np.array([pt['u'] for pt in points])
v = np.array([pt['v'] for pt in points])
T = np.array([pt['T_C'] for pt in points])
P = np.array([pt['P_MPa'] for pt in points])

# Create figure
fig, ax = plt.subplots(figsize=(14, 10))

ax.set_xscale('log')

# Color by pressure (log scale)
P_log = np.log10(P + 0.0001)
scatter = ax.scatter(v, u, c=P_log, cmap='viridis', s=8, alpha=0.7,
                     picker=True, pickradius=5)

# Colorbar
cbar = plt.colorbar(scatter, ax=ax, label='log₁₀(P [MPa])')
cbar.set_ticks([-3, -2, -1, 0, 1, 2])
cbar.set_ticklabels(['0.001', '0.01', '0.1', '1', '10', '100'])

# Saturation dome
ax.plot(dome_v, dome_u, 'r-', linewidth=2, label='Saturation dome')
ax.fill(dome_v, dome_u, alpha=0.15, color='red')

ax.set_xlabel('Specific Volume v (m³/kg)', fontsize=12)
ax.set_ylabel('Internal Energy u (kJ/kg)', fontsize=12)
ax.set_title(f'(u, v) Grid - {len(points)} points, colored by pressure\n'
             'Hover over points for details', fontsize=12)

ax.legend(loc='upper left')
ax.grid(True, alpha=0.3, which='both')
ax.set_xlim(0.0009, 200)
ax.set_ylim(-50, 3400)

# Hover annotation
annot = ax.annotate("", xy=(0, 0), xytext=(20, 20),
                    textcoords="offset points",
                    bbox=dict(boxstyle="round,pad=0.5", fc="yellow", alpha=0.9),
                    arrowprops=dict(arrowstyle="->"),
                    fontsize=10)
annot.set_visible(False)


def update_annot(ind):
    idx = ind["ind"][0]
    pos = scatter.get_offsets()[idx]
    annot.xy = pos

    pt = points[idx]
    text = (f"u = {pt['u']:.2f} kJ/kg\n"
            f"v = {pt['v']:.8f} m³/kg\n"
            f"T = {pt['T_C']:.2f} °C\n"
            f"P = {pt['P_MPa']:.6f} MPa\n"
            f"Phase: {pt['region']}")
    annot.set_text(text)


def hover(event):
    vis = annot.get_visible()
    if event.inaxes == ax:
        cont, ind = scatter.contains(event)
        if cont:
            update_annot(ind)
            annot.set_visible(True)
            fig.canvas.draw_idle()
        else:
            if vis:
                annot.set_visible(False)
                fig.canvas.draw_idle()


fig.canvas.mpl_connect("motion_notify_event", hover)

plt.tight_layout()
plt.show()
