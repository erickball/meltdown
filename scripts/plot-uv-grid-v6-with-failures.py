"""
Visualization of v6 (u, v) grid with failed points shown.
"""

import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Load successful points - use v8 now
data_path = Path(__file__).parent / 'uv_grid_data_v8.json'
with open(data_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} solved points")

# Load saturation dome
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points_data = dome_data['raw_data']
sat_u_f = np.array([pt['u_f'] for pt in sat_points_data])
sat_v_f = np.array([pt['v_f'] for pt in sat_points_data])
sat_u_g = np.array([pt['u_g'] for pt in sat_points_data])
sat_v_g = np.array([pt['v_g'] for pt in sat_points_data])

dome_u = list(sat_u_f) + list(sat_u_g[::-1])
dome_v = list(sat_v_f) + list(sat_v_g[::-1])

# Recreate the target grid to find failures
# (Same logic as build-uv-grid-v6.py)

def get_v_f_at_u(u):
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])

# Generate all targets
all_targets = []

# Compressed liquid
u_values_liq = np.concatenate([
    np.arange(0, 400, 2),
    np.arange(400, 800, 3),
    np.arange(800, 1200, 5),
    np.arange(1200, 1600, 8),
    np.arange(1600, 1950, 10),
])

for u in u_values_liq:
    v_f = get_v_f_at_u(u)
    if v_f is None:
        continue
    if u < 400:
        v_offsets = [1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4]
    elif u < 800:
        v_offsets = [2e-7, 5e-7, 1e-6, 5e-6, 2e-5, 1e-4, 5e-4]
    elif u < 1200:
        v_offsets = [5e-7, 2e-6, 1e-5, 5e-5, 2e-4]
    else:
        v_offsets = [1e-6, 5e-6, 2e-5, 1e-4]
    for dv in v_offsets:
        v = v_f - dv
        if v > 0.0009:
            all_targets.append({'u': float(u), 'v': float(v), 'region': 'compressed_liquid'})

# Vapor - v8 style with validity checking
from scipy.interpolate import interp1d
vg_sort_idx = np.argsort(sat_v_g)
vg_sorted = sat_v_g[vg_sort_idx]
ug_sorted = sat_u_g[vg_sort_idx]
u_g_from_v = interp1d(vg_sorted, ug_sorted, bounds_error=False, fill_value=(ug_sorted[0], ug_sorted[-1]))
v_crit = sat_v_f[-1]
u_crit = sat_u_f[-1]

for v in np.logspace(np.log10(v_crit), np.log10(100), 50):
    u_g_min = u_g_from_v(v)
    if np.isnan(u_g_min):
        u_g_min = 2400
    u_start = u_g_min + 20
    u_end = 3300
    for u in np.arange(u_start, u_end, 20):
        if u > u_g_from_v(v) + 5:
            all_targets.append({'u': float(u), 'v': float(v), 'region': 'vapor'})

# Supercritical - v8 style
for u in np.arange(2000, 2800, 15):
    for v in np.logspace(np.log10(0.002), np.log10(v_crit), 20):
        if u < u_crit and v < v_crit * 0.8:
            continue
        all_targets.append({'u': float(u), 'v': float(v), 'region': 'supercritical'})

print(f"Total targets: {len(all_targets)}")

# Find which targets succeeded vs failed
solved_set = set((round(p['u'], 6), round(p['v'], 9)) for p in points)

failed_targets = []
for t in all_targets:
    key = (round(t['u'], 6), round(t['v'], 9))
    if key not in solved_set:
        failed_targets.append(t)

print(f"Failed targets: {len(failed_targets)}")

# Extract arrays
u_solved = np.array([pt['u'] for pt in points])
v_solved = np.array([pt['v'] for pt in points])
P_solved = np.array([pt['P_MPa'] for pt in points])

u_failed = np.array([pt['u'] for pt in failed_targets])
v_failed = np.array([pt['v'] for pt in failed_targets])
region_failed = [pt['region'] for pt in failed_targets]

# Create figure
fig, axes = plt.subplots(2, 2, figsize=(16, 14))

# Full view
ax = axes[0, 0]
ax.set_xscale('log')
ax.scatter(v_solved, u_solved, c='blue', s=3, alpha=0.5, label=f'Solved ({len(points)})')
ax.scatter(v_failed, u_failed, c='red', s=8, alpha=0.7, marker='x', label=f'Failed ({len(failed_targets)})')
ax.plot(dome_v, dome_u, 'k-', linewidth=2, label='Sat. dome')
ax.fill(dome_v, dome_u, alpha=0.1, color='gray')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Full view - solved (blue) vs failed (red X)')
ax.set_xlim(0.0008, 200)
ax.set_ylim(-50, 3400)
ax.legend()
ax.grid(True, alpha=0.3)

# Compressed liquid zoom
ax = axes[0, 1]
liq_mask_solved = np.array([p['region'] == 'compressed_liquid' for p in points])
liq_mask_failed = np.array([r == 'compressed_liquid' for r in region_failed])

ax.scatter(v_solved[liq_mask_solved], u_solved[liq_mask_solved], c='blue', s=5, alpha=0.5, label='Solved')
if np.any(liq_mask_failed):
    ax.scatter(v_failed[liq_mask_failed], u_failed[liq_mask_failed], c='red', s=15, alpha=0.8, marker='x', label='Failed')
ax.plot(sat_v_f, sat_u_f, 'k-', linewidth=2, label='Sat. liquid')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Compressed liquid region')
ax.legend()
ax.grid(True, alpha=0.3)

# Vapor/supercritical zoom
ax = axes[1, 0]
ax.set_xscale('log')
vap_mask_solved = np.array([p['region'] in ['vapor', 'supercritical'] for p in points])
vap_mask_failed = np.array([r in ['vapor', 'supercritical'] for r in region_failed])

ax.scatter(v_solved[vap_mask_solved], u_solved[vap_mask_solved], c='blue', s=5, alpha=0.5, label='Solved')
if np.any(vap_mask_failed):
    ax.scatter(v_failed[vap_mask_failed], u_failed[vap_mask_failed], c='red', s=15, alpha=0.8, marker='x', label='Failed')
ax.plot(dome_v, dome_u, 'k-', linewidth=2)
ax.fill(dome_v, dome_u, alpha=0.1, color='gray')
ax.set_xlabel('v (m³/kg)')
ax.set_ylabel('u (kJ/kg)')
ax.set_title('Vapor and supercritical regions')
ax.set_xlim(0.002, 200)
ax.set_ylim(1800, 3400)
ax.legend()
ax.grid(True, alpha=0.3)

# Failure analysis by region and u-value
ax = axes[1, 1]
for region, color, marker in [('compressed_liquid', 'blue', 'o'),
                               ('vapor', 'green', 's'),
                               ('supercritical', 'orange', '^')]:
    mask = np.array([r == region for r in region_failed])
    if np.any(mask):
        ax.scatter(u_failed[mask], v_failed[mask], c=color, s=20, alpha=0.7,
                   marker=marker, label=f'{region} ({np.sum(mask)})')

ax.set_yscale('log')
ax.set_xlabel('u (kJ/kg)')
ax.set_ylabel('v (m³/kg)')
ax.set_title('Failed points by region')
ax.legend()
ax.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(Path(__file__).parent / 'uv_grid_v6_failures.png', dpi=150)
plt.show()

# Print failure statistics
print("\n" + "=" * 60)
print("Failure analysis")
print("=" * 60)

for region in ['compressed_liquid', 'vapor', 'supercritical']:
    mask = np.array([r == region for r in region_failed])
    if np.any(mask):
        u_reg = u_failed[mask]
        v_reg = v_failed[mask]
        print(f"\n{region}: {np.sum(mask)} failures")
        print(f"  u range: {u_reg.min():.1f} to {u_reg.max():.1f} kJ/kg")
        print(f"  v range: {v_reg.min():.2e} to {v_reg.max():.2e} m³/kg")

        # For compressed liquid, check v offset from saturation
        if region == 'compressed_liquid':
            offsets = []
            for u, v in zip(u_reg, v_reg):
                v_f = get_v_f_at_u(u)
                if v_f:
                    offsets.append(v_f - v)
            if offsets:
                offsets = np.array(offsets)
                print(f"  v offset from sat: {offsets.min():.2e} to {offsets.max():.2e}")
                print(f"  Failures with offset < 1e-6: {np.sum(offsets < 1e-6)}")
                print(f"  Failures with offset 1e-6 to 1e-5: {np.sum((offsets >= 1e-6) & (offsets < 1e-5))}")
