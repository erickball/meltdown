"""
Visualization of v9 (u, v) grid.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load v9 data
data_path = Path(__file__).parent / 'uv_grid_data_v9.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} points")

# Load saturation dome
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points_data = dome_data['raw_data']
sat_u_f = np.array([pt['u_f'] for pt in sat_points_data])
sat_v_f = np.array([pt['v_f'] for pt in sat_points_data])
sat_u_g = np.array([pt['u_g'] for pt in sat_points_data])
sat_v_g = np.array([pt['v_g'] for pt in sat_points_data])

# Extract arrays
u = np.array([pt['u'] for pt in points])
v = np.array([pt['v'] for pt in points])
P = np.array([pt['P_MPa'] for pt in points])
regions = [pt['region'] for pt in points]

# Create figure
fig, axes = plt.subplots(2, 2, figsize=(16, 14))

# Full view
ax = axes[0, 0]
ax.set_xscale('log')
liq_mask = np.array([r == 'compressed_liquid' for r in regions])
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

# Compressed liquid zoom
ax = axes[0, 1]
ax.scatter(v[liq_mask], u[liq_mask], c=P[liq_mask], cmap='viridis', s=3, alpha=0.7)
ax.plot(sat_v_f, sat_u_f, 'r-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Compressed liquid - colored by pressure')
ax.legend()
ax.grid(True, alpha=0.3)

# Low-T compressed liquid zoom
ax = axes[1, 0]
low_T_mask = liq_mask & (u < 500)
ax.scatter(v[low_T_mask], u[low_T_mask], c='blue', s=5, alpha=0.7)
sat_low_mask = sat_u_f < 500
ax.plot(sat_v_f[sat_low_mask], sat_u_f[sat_low_mask], 'r-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Low-T compressed liquid (u < 500)')
ax.legend()
ax.grid(True, alpha=0.3)

# High-T compressed liquid zoom (near critical)
ax = axes[1, 1]
high_T_mask = liq_mask & (u > 1500)
ax.scatter(v[high_T_mask], u[high_T_mask], c='blue', s=5, alpha=0.7)
sat_high_mask = sat_u_f > 1500
ax.plot(sat_v_f[sat_high_mask], sat_u_f[sat_high_mask], 'r-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('High-T compressed liquid (u > 1500, near critical)')
ax.legend()
ax.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(Path(__file__).parent / 'uv_grid_v9.png', dpi=150)
plt.show()

# Print curve info
print("\nCompressed liquid curve analysis:")
print("Checking that all 8 curves run continuously...")

liq_points = [p for p in points if p['region'] == 'compressed_liquid']
u_liq = np.array([p['u'] for p in liq_points])
v_liq = np.array([p['v'] for p in liq_points])

# Group by approximate u value
u_unique = np.unique(np.round(u_liq, 1))
print(f"Number of unique u values: {len(u_unique)}")
print(f"u range: {u_unique[0]:.1f} to {u_unique[-1]:.1f}")

# Count points at each u
counts_at_u = []
for u_val in u_unique:
    mask = np.abs(u_liq - u_val) < 0.5
    counts_at_u.append(np.sum(mask))

print(f"Points per u value: min={min(counts_at_u)}, max={max(counts_at_u)}, mean={np.mean(counts_at_u):.1f}")

# Check for gaps
gap_u_values = [u_unique[i] for i in range(len(counts_at_u)) if counts_at_u[i] < 6]
if gap_u_values:
    print(f"U values with < 6 points: {gap_u_values[:10]}...")
else:
    print("All u values have at least 6 points (good coverage)")
