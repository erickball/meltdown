"""
Interactive visualization of (u, v) grid data.

Shows points in (u, v) space colored by pressure.
Hover over points to see T, P, u, v values.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import Cursor
from pathlib import Path

# Load the grid data
data_path = Path(__file__).parent / 'uv_grid_data_v3.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} points")

# Extract arrays
u = np.array([pt['u'] for pt in points])
v = np.array([pt['v'] for pt in points])
T = np.array([pt['T_C'] for pt in points])
P = np.array([pt['P_MPa'] for pt in points])
phase = [pt['phase'] for pt in points]

# Load saturation dome for overlay
sat_data = []
sat_path = Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt'
with open(sat_path, 'r') as f:
    lines = f.readlines()
    for line in lines[1:]:
        parts = line.strip().split('\t')
        if len(parts) >= 6:
            try:
                sat_data.append({
                    'v_f': float(parts[2]),
                    'v_g': float(parts[3]),
                    'u_f': float(parts[4]),
                    'u_g': float(parts[5]),
                })
            except:
                pass

# Saturation dome boundary
u_f = [pt['u_f'] for pt in sat_data]
v_f = [pt['v_f'] for pt in sat_data]
u_g = [pt['u_g'] for pt in sat_data]
v_g = [pt['v_g'] for pt in sat_data]

# Combine into dome curve (liquid line + reversed vapor line)
dome_u = u_f + u_g[::-1]
dome_v = v_f + v_g[::-1]

# Create figure
fig, ax = plt.subplots(figsize=(14, 10))

# Use log scale for v
ax.set_xscale('log')

# Color by pressure (log scale)
P_log = np.log10(P + 0.0001)  # Avoid log(0)
scatter = ax.scatter(v, u, c=P_log, cmap='viridis', s=15, alpha=0.7,
                     picker=True, pickradius=5)

# Add colorbar
cbar = plt.colorbar(scatter, ax=ax, label='log₁₀(P [MPa])')
cbar.set_ticks([-3, -2, -1, 0, 1, 2])
cbar.set_ticklabels(['0.001', '0.01', '0.1', '1', '10', '100'])

# Plot saturation dome
ax.plot(dome_v, dome_u, 'r-', linewidth=2, label='Saturation dome')
ax.fill(dome_v, dome_u, alpha=0.15, color='red')

# Labels
ax.set_xlabel('Specific Volume v (m³/kg)', fontsize=12)
ax.set_ylabel('Internal Energy u (kJ/kg)', fontsize=12)
ax.set_title('Water Properties Grid in (u, v) Space\n'
             f'{len(points)} points, colored by pressure\n'
             'Hover over points for details', fontsize=12)

ax.legend(loc='upper left')
ax.grid(True, alpha=0.3, which='both')

# Set axis limits
ax.set_xlim(0.0008, 500)
ax.set_ylim(-50, 3400)

# Annotation for hover
annot = ax.annotate("", xy=(0, 0), xytext=(20, 20),
                    textcoords="offset points",
                    bbox=dict(boxstyle="round,pad=0.5", fc="yellow", alpha=0.9),
                    arrowprops=dict(arrowstyle="->"),
                    fontsize=10)
annot.set_visible(False)


def update_annot(ind):
    """Update annotation with point info."""
    idx = ind["ind"][0]
    pos = scatter.get_offsets()[idx]
    annot.xy = pos

    pt = points[idx]
    text = (f"u = {pt['u']:.2f} kJ/kg\n"
            f"v = {pt['v']:.6f} m³/kg\n"
            f"T = {pt['T_C']:.1f} °C\n"
            f"P = {pt['P_MPa']:.4f} MPa\n"
            f"ρ = {pt['rho']:.2f} kg/m³\n"
            f"Phase: {pt['phase']}")
    annot.set_text(text)


def hover(event):
    """Handle hover events."""
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

# Add text showing regions
ax.text(0.002, 500, 'Compressed\nLiquid', fontsize=10, ha='center',
        bbox=dict(boxstyle='round', facecolor='lightblue', alpha=0.7))
ax.text(0.1, 2800, 'Superheated\nVapor', fontsize=10, ha='center',
        bbox=dict(boxstyle='round', facecolor='lightyellow', alpha=0.7))
ax.text(0.005, 2100, 'Supercritical', fontsize=10, ha='center',
        bbox=dict(boxstyle='round', facecolor='lightgreen', alpha=0.7))
ax.text(0.01, 1200, 'Two-Phase\n(handled separately)', fontsize=10, ha='center',
        color='red', alpha=0.7)

plt.tight_layout()
plt.show()
