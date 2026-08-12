"""
Interactive visualization of v4 (u, v) grid data.
Shows points colored by pressure with hover info.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load the grid data
data_path = Path(__file__).parent / 'uv_grid_data_v4.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} points")

# Extract arrays
u = np.array([pt['u'] for pt in points])
v = np.array([pt['v'] for pt in points])
T = np.array([pt['T_C'] for pt in points])
P = np.array([pt['P_MPa'] for pt in points])

# Load saturation dome
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
u_f = [pt['u_f'] for pt in sat_points]
v_f = [pt['v_f'] for pt in sat_points]
u_g = [pt['u_g'] for pt in sat_points]
v_g = [pt['v_g'] for pt in sat_points]

# Dome boundary
dome_u = u_f + u_g[::-1]
dome_v = v_f + v_g[::-1]

# Create figure
fig, ax = plt.subplots(figsize=(14, 10))

ax.set_xscale('log')

# Color by pressure
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
ax.set_title(f'Adaptive (u, v) Grid - {len(points)} points\n'
             'Colored by pressure, hover for details', fontsize=12)

ax.legend(loc='upper left')
ax.grid(True, alpha=0.3, which='both')
ax.set_xlim(0.0008, 500)
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
            f"Phase: {pt['phase']}\n"
            f"Region: {pt.get('region', 'N/A')}")
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

# Region labels
ax.text(0.0012, 500, 'Compressed\nLiquid', fontsize=10, ha='center',
        bbox=dict(boxstyle='round', facecolor='lightblue', alpha=0.7))
ax.text(1, 2800, 'Superheated\nVapor', fontsize=10, ha='center',
        bbox=dict(boxstyle='round', facecolor='lightyellow', alpha=0.7))
ax.text(0.005, 2200, 'Super-\ncritical', fontsize=10, ha='center',
        bbox=dict(boxstyle='round', facecolor='lightgreen', alpha=0.7))

plt.tight_layout()
plt.show()
