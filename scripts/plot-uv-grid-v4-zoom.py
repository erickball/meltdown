"""
Zoomed view of compressed liquid region near saturation.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load data
data_path = Path(__file__).parent / 'uv_grid_data_v4.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']

# Filter to compressed liquid only
liquid_points = [pt for pt in points if pt['phase'] == 'compressed_liquid']
print(f"Compressed liquid points: {len(liquid_points)}")

u = np.array([pt['u'] for pt in liquid_points])
v = np.array([pt['v'] for pt in liquid_points])
T = np.array([pt['T_C'] for pt in liquid_points])
P = np.array([pt['P_MPa'] for pt in liquid_points])

# Load saturation dome
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
u_f = np.array([pt['u_f'] for pt in sat_points])
v_f = np.array([pt['v_f'] for pt in sat_points])

# Create figure with multiple zoom levels
fig, axes = plt.subplots(2, 2, figsize=(14, 12))

# Full compressed liquid view
ax = axes[0, 0]
ax.scatter(v, u, c=P, cmap='viridis', s=5, alpha=0.7)
ax.plot(v_f, u_f, 'r-', linewidth=2, label='Sat. liquid line')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Full compressed liquid region')
ax.legend()
ax.grid(True, alpha=0.3)

# Zoom: low T (0-100 C, u ~ 0-420)
ax = axes[0, 1]
mask = (u >= 0) & (u <= 420)
ax.scatter(v[mask], u[mask], c=P[mask], cmap='viridis', s=10, alpha=0.7)
mask_sat = (u_f >= 0) & (u_f <= 420)
ax.plot(v_f[mask_sat], u_f[mask_sat], 'r-', linewidth=2)
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Low T (0-100°C)')
ax.grid(True, alpha=0.3)

# Very fine zoom near saturation at T ~ 50 C (u ~ 210)
ax = axes[1, 0]
mask = (u >= 200) & (u <= 220)
sc = ax.scatter(v[mask], u[mask], c=P[mask], cmap='viridis', s=20, alpha=0.7)
mask_sat = (u_f >= 200) & (u_f <= 220)
ax.plot(v_f[mask_sat], u_f[mask_sat], 'r-', linewidth=2, label='Sat. line')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Near 50°C, zoomed to see spacing')
ax.legend()
ax.grid(True, alpha=0.3)
plt.colorbar(sc, ax=ax, label='P (MPa)')

# Near saturation detail - show v offset from v_f
ax = axes[1, 1]
# For each point, calculate distance from saturation
v_offsets = []
for pt in liquid_points:
    # Find v_f at this u
    idx = np.searchsorted(u_f, pt['u'])
    if idx > 0 and idx < len(u_f):
        v_sat = v_f[idx-1] + (pt['u'] - u_f[idx-1]) / (u_f[idx] - u_f[idx-1]) * (v_f[idx] - v_f[idx-1])
        v_offsets.append(v_sat - pt['v'])  # Distance below saturation
    else:
        v_offsets.append(0)

v_offsets = np.array(v_offsets)

# Histogram of v offsets
valid_offsets = v_offsets[(v_offsets > 0) & (v_offsets < 0.001)]
ax.hist(valid_offsets, bins=50, edgecolor='black', alpha=0.7)
ax.set_xlabel('v_f - v (distance below saturation, m³/kg)')
ax.set_ylabel('Count')
ax.set_title('Distribution of v-offsets from saturation')
ax.axvline(1e-7, color='r', linestyle='--', label='1e-7')
ax.axvline(1e-6, color='g', linestyle='--', label='1e-6')
ax.axvline(1e-5, color='b', linestyle='--', label='1e-5')
ax.legend()
ax.set_xscale('log')

plt.tight_layout()
plt.savefig(Path(__file__).parent / 'uv_grid_v4_zoom.png', dpi=150)
plt.show()

# Print some statistics
print(f"\nV-offset statistics:")
print(f"  Min offset: {v_offsets[v_offsets > 0].min():.2e}")
print(f"  Max offset: {v_offsets.max():.2e}")
print(f"  Points with offset < 1e-6: {np.sum((v_offsets > 0) & (v_offsets < 1e-6))}")
print(f"  Points with offset 1e-6 to 1e-5: {np.sum((v_offsets >= 1e-6) & (v_offsets < 1e-5))}")
print(f"  Points with offset > 1e-5: {np.sum(v_offsets >= 1e-5)}")

# Check u spacing
u_sorted = np.sort(np.unique(u))
u_diffs = np.diff(u_sorted)
print(f"\nU spacing statistics:")
print(f"  Min u step: {u_diffs.min():.2f} kJ/kg")
print(f"  Max u step: {u_diffs.max():.2f} kJ/kg")
print(f"  Mean u step: {u_diffs.mean():.2f} kJ/kg")
