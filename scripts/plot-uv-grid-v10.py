"""
Visualization of v10 (u, v) grid with log offset scaling.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load v10 data
data_path = Path(__file__).parent / 'uv_grid_data_v10.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} points")

# Load saturation dome (filtered version matches v10)
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points_raw = dome_data['raw_data']
# Filter out index 274 to match v10
sat_points_data = [p for i, p in enumerate(sat_points_raw) if i != 274]

sat_u_f = np.array([pt['u_f'] for pt in sat_points_data])
sat_v_f = np.array([pt['v_f'] for pt in sat_points_data])
sat_u_g = np.array([pt['u_g'] for pt in sat_points_data])
sat_v_g = np.array([pt['v_g'] for pt in sat_points_data])

# Extract arrays
u = np.array([pt['u'] for pt in points])
v = np.array([pt['v'] for pt in points])
P = np.array([pt['P_MPa'] for pt in points])
regions = [pt['region'] for pt in points]

liq_mask = np.array([r == 'compressed_liquid' for r in regions])

# Create figure
fig, axes = plt.subplots(2, 2, figsize=(16, 14))

# Full view
ax = axes[0, 0]
ax.set_xscale('log')
vap_mask = np.array([r == 'vapor' for r in regions])
sc_mask = np.array([r == 'supercritical' for r in regions])

ax.scatter(v[liq_mask], u[liq_mask], c='blue', s=2, alpha=0.5, label=f'Liquid ({np.sum(liq_mask)})')
ax.scatter(v[vap_mask], u[vap_mask], c='green', s=2, alpha=0.5, label=f'Vapor ({np.sum(vap_mask)})')
ax.scatter(v[sc_mask], u[sc_mask], c='orange', s=2, alpha=0.5, label=f'Supercrit ({np.sum(sc_mask)})')

dome_u = list(sat_u_f) + list(sat_u_g[::-1])
dome_v = list(sat_v_f) + list(sat_v_g[::-1])
ax.plot(dome_v, dome_u, 'r-', linewidth=2)
ax.fill(dome_v, dome_u, alpha=0.1, color='red')

ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title(f'Full view - {len(points)} points')
ax.set_xlim(0.0009, 200)
ax.set_ylim(-50, 3400)
ax.legend()
ax.grid(True, alpha=0.3)

# Compressed liquid - full view
ax = axes[0, 1]
ax.scatter(v[liq_mask], u[liq_mask], c='blue', s=3, alpha=0.7)
ax.plot(sat_v_f, sat_u_f, 'r-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Compressed liquid - all 8 curves')
ax.legend()
ax.grid(True, alpha=0.3)

# Low-T zoom to see curve spacing
ax = axes[1, 0]
low_T_mask = liq_mask & (u < 400)
ax.scatter(v[low_T_mask], u[low_T_mask], c='blue', s=8, alpha=0.7)
sat_low_mask = sat_u_f < 400
ax.plot(sat_v_f[sat_low_mask], sat_u_f[sat_low_mask], 'r-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Low-T (u < 400) - curves closer together')
ax.legend()
ax.grid(True, alpha=0.3)

# High-T zoom to see curve spacing
ax = axes[1, 1]
high_T_mask = liq_mask & (u > 1200) & (u < 1800)
ax.scatter(v[high_T_mask], u[high_T_mask], c='blue', s=8, alpha=0.7)
sat_high_mask = (sat_u_f > 1200) & (sat_u_f < 1800)
ax.plot(sat_v_f[sat_high_mask], sat_u_f[sat_high_mask], 'r-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('High-T (1200 < u < 1800) - curves spread apart')
ax.legend()
ax.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(Path(__file__).parent / 'uv_grid_v10.png', dpi=150)
plt.show()

# Analyze the 8 curves
print("\nAnalyzing the 8 offset curves:")
liq_points = [p for p in points if p['region'] == 'compressed_liquid']
u_liq = np.array([p['u'] for p in liq_points])
v_liq = np.array([p['v'] for p in liq_points])

# At each u, count how many v points we have
u_unique = np.unique(np.round(u_liq, 0))
counts = []
for u_val in u_unique:
    mask = np.abs(u_liq - u_val) < 1
    counts.append(np.sum(mask))

print(f"Points per u value: min={min(counts)}, max={max(counts)}, mean={np.mean(counts):.1f}")
print(f"U values with < 8 points: {sum(1 for c in counts if c < 8)}")
