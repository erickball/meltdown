"""
Visualization of v6 (u, v) grid with failure analysis.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load successful points
data_path = Path(__file__).parent / 'uv_grid_data_v6.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} solved points")

# Also load the v6 script to extract failed targets
# (We'll recreate them here for visualization)

# Load saturation dome
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
u_f = np.array([pt['u_f'] for pt in sat_points])
v_f = np.array([pt['v_f'] for pt in sat_points])
u_g = np.array([pt['u_g'] for pt in sat_points])
v_g = np.array([pt['v_g'] for pt in sat_points])

dome_u = list(u_f) + list(u_g[::-1])
dome_v = list(v_f) + list(v_g[::-1])

# Extract arrays
u = np.array([pt['u'] for pt in points])
v = np.array([pt['v'] for pt in points])
T = np.array([pt['T_C'] for pt in points])
P = np.array([pt['P_MPa'] for pt in points])
regions = [pt['region'] for pt in points]

# Create figure
fig, axes = plt.subplots(2, 2, figsize=(15, 12))

# Full view
ax = axes[0, 0]
ax.set_xscale('log')
scatter = ax.scatter(v, u, c=np.log10(P + 0.001), cmap='viridis', s=3, alpha=0.7)
ax.plot(dome_v, dome_u, 'r-', linewidth=2, label='Sat. dome')
ax.fill(dome_v, dome_u, alpha=0.1, color='red')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title(f'Full view - {len(points)} points')
ax.set_xlim(0.0008, 200)
ax.set_ylim(-50, 3400)
ax.legend()
ax.grid(True, alpha=0.3)
plt.colorbar(scatter, ax=ax, label='log₁₀(P)')

# Compressed liquid zoom
ax = axes[0, 1]
liq_mask = np.array([r == 'compressed_liquid' for r in regions])
ax.scatter(v[liq_mask], u[liq_mask], c=T[liq_mask], cmap='coolwarm', s=5, alpha=0.7)
ax.plot(v_f, u_f, 'k-', linewidth=2, label='Sat. liquid line')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Compressed liquid')
ax.legend()
ax.grid(True, alpha=0.3)

# Very close to saturation
ax = axes[1, 0]
# Find points very close to saturation (small v offset)
close_mask = liq_mask & (v > 0.001) & (v < 0.0015)
if np.any(close_mask):
    ax.scatter(v[close_mask], u[close_mask], c=T[close_mask], cmap='coolwarm', s=10, alpha=0.7)
ax.plot(v_f, u_f, 'k-', linewidth=2, label='Sat. liquid line')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Near saturation (v ~ 0.001-0.0015)')
ax.set_xlim(0.001, 0.0015)
ax.legend()
ax.grid(True, alpha=0.3)

# Temperature distribution
ax = axes[1, 1]
liq_T = T[liq_mask]
ax.hist(liq_T, bins=50, edgecolor='black', alpha=0.7)
ax.set_xlabel('Temperature (°C)')
ax.set_ylabel('Count')
ax.set_title('Temperature distribution in compressed liquid')
ax.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(Path(__file__).parent / 'uv_grid_v6_analysis.png', dpi=150)
plt.show()

# Print statistics by region
print("\nPoints by region:")
for region in ['compressed_liquid', 'vapor', 'supercritical']:
    mask = np.array([r == region for r in regions])
    if np.any(mask):
        print(f"  {region}: {np.sum(mask)} points")
        print(f"    T range: {T[mask].min():.1f} to {T[mask].max():.1f} °C")
        print(f"    P range: {P[mask].min():.4f} to {P[mask].max():.2f} MPa")
        print(f"    u range: {u[mask].min():.1f} to {u[mask].max():.1f} kJ/kg")
        print(f"    v range: {v[mask].min():.6f} to {v[mask].max():.4f} m³/kg")
