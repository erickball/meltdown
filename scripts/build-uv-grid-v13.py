"""
Build (u, v) grid - Version 13.

Compressed liquid: 8 curves with:
- log10(v_offset) increasing at rates that double at u=1000, 1200, 1400
- Point density decreasing by 30% for each curve farther from saturation
  (curves 0,1 at full density, curve 2 at 70%, curve 3 at 49%, etc.)
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
from scipy.optimize import root
from scipy.interpolate import LinearNDInterpolator, interp1d
import time

# Load saturation dome and filter out problematic point
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points_raw = dome_data['raw_data']
print(f"Loaded {len(sat_points_raw)} saturation points")

sat_points = [p for i, p in enumerate(sat_points_raw) if i != 274]
print(f"After filtering: {len(sat_points)} saturation points")

sat_T = np.array([pt['T_K'] for pt in sat_points])
sat_u_f = np.array([pt['u_f'] for pt in sat_points])
sat_v_f = np.array([pt['v_f'] for pt in sat_points])
sat_u_g = np.array([pt['u_g'] for pt in sat_points])
sat_v_g = np.array([pt['v_g'] for pt in sat_points])
sat_P = np.array([pt['P_MPa'] for pt in sat_points])

T_crit = 647.096
P_crit = 22.064
u_crit = sat_u_f[-1]
v_crit = sat_v_f[-1]

vg_sort_idx = np.argsort(sat_v_g)
vg_sorted = sat_v_g[vg_sort_idx]
ug_sorted = sat_u_g[vg_sort_idx]
u_g_from_v = interp1d(vg_sorted, ug_sorted, bounds_error=False, fill_value=(ug_sorted[0], ug_sorted[-1]))


def get_v_f_at_u(u):
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    if idx >= len(sat_u_f):
        idx = len(sat_u_f) - 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])


def get_T_sat_at_u_f(u):
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    if idx >= len(sat_u_f):
        idx = len(sat_u_f) - 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])


v5_path = Path(__file__).parent / 'uv_grid_data_v5.json'
with open(v5_path, 'r') as f:
    v5_data = json.load(f)

v5_points = v5_data['points']
v5_u = np.array([pt['u'] for pt in v5_points])
v5_v = np.array([pt['v'] for pt in v5_points])
v5_T = np.array([pt['T_K'] for pt in v5_points])
v5_P = np.array([pt['P_MPa'] for pt in v5_points])
v5_logv = np.log10(v5_v)

coords = np.column_stack([v5_u, v5_logv])
T_interp = LinearNDInterpolator(coords, v5_T, fill_value=np.nan)
P_interp = LinearNDInterpolator(coords, v5_P, fill_value=np.nan)


def get_initial_guess(u, v, region):
    logv = np.log10(v)
    T_guess = T_interp(u, logv)
    P_guess = P_interp(u, logv)

    if not np.isnan(T_guess) and not np.isnan(P_guess):
        return float(T_guess), float(P_guess)

    if region == 'compressed_liquid':
        T_sat = get_T_sat_at_u_f(u)
        if T_sat:
            return float(T_sat), 20.0
        return 400.0, 20.0
    elif region == 'vapor':
        return 450.0, 0.5
    else:
        return 700.0, 30.0


def find_TP_from_uv(u_target, v_target, region, max_attempts=8):
    def objective(x):
        T, P = x
        if T < 273.16 or T > 1100 or P < 1e-6 or P > 100:
            return [1e10, 1e10]
        try:
            water = IAPWS97(T=T, P=P)
            if water.u is None or water.v is None:
                return [1e10, 1e10]
            return [
                (water.u - u_target) / 10,
                (water.v - v_target) / v_target * 100
            ]
        except:
            return [1e10, 1e10]

    T_init, P_init = get_initial_guess(u_target, v_target, region)

    guesses = [(T_init, P_init)]
    if region == 'compressed_liquid':
        guesses += [
            (T_init, P_init * 2),
            (T_init, P_init * 0.5),
            (T_init + 20, P_init),
            (T_init - 20, P_init),
        ]
    elif region == 'vapor':
        guesses += [
            (T_init + 50, P_init),
            (T_init - 50, P_init),
            (T_init, P_init * 2),
            (T_init, P_init * 0.5),
            (400, 0.1),
            (500, 0.5),
            (600, 1.0),
        ]
    else:
        guesses += [
            (T_init + 50, P_init),
            (T_init, P_init * 1.5),
            (700, 25),
            (750, 30),
        ]

    for T_try, P_try in guesses[:max_attempts]:
        try:
            result = root(objective, [T_try, P_try], method='hybr', tol=1e-10)
            if result.success:
                T, P = result.x
                if 273.16 <= T <= 1100 and 1e-6 <= P <= 100:
                    water = IAPWS97(T=T, P=P)
                    if water.u is not None and water.v is not None:
                        u_err = abs(water.u - u_target)
                        v_err = abs(water.v - v_target) / v_target
                        if u_err < 0.1 and v_err < 1e-5:
                            return {'T_K': float(T), 'T_C': float(T - 273.15), 'P_MPa': float(P)}
        except:
            pass

    return None


# Generate targets
print("\n" + "=" * 60)
print("Generating targets")
print("=" * 60)

targets = []

print("\nCompressed liquid targets:")

# Base log10(v_offset) values at u=0
# Curve 0 is closest to saturation (smallest offset), curve 7 is farthest
base_log_offsets = np.array([-7, -6.7, -6.3, -6, -5.7, -5.3, -5, -4.7])

# Base rate for log offset scaling
base_rate = 0.114 / 800

def get_log_v_offset(base_log_offset, u):
    """Rate doubles at u=1000, 1200, 1400."""
    if u <= 800:
        return base_log_offset + base_rate * u
    elif u <= 1000:
        val_at_800 = base_rate * 800
        return base_log_offset + val_at_800 + (2 * base_rate) * (u - 800)
    elif u <= 1200:
        val_at_800 = base_rate * 800
        val_at_1000 = val_at_800 + (2 * base_rate) * 200
        return base_log_offset + val_at_1000 + (4 * base_rate) * (u - 1000)
    elif u <= 1400:
        val_at_800 = base_rate * 800
        val_at_1000 = val_at_800 + (2 * base_rate) * 200
        val_at_1200 = val_at_1000 + (4 * base_rate) * 200
        return base_log_offset + val_at_1200 + (8 * base_rate) * (u - 1200)
    else:
        val_at_800 = base_rate * 800
        val_at_1000 = val_at_800 + (2 * base_rate) * 200
        val_at_1200 = val_at_1000 + (4 * base_rate) * 200
        val_at_1400 = val_at_1200 + (8 * base_rate) * 200
        return base_log_offset + val_at_1400 + (16 * base_rate) * (u - 1400)

# u spacing for each curve
# Curves 0, 1: full density (step=2)
# Curve 2: 70% density (step=2/0.7 ≈ 2.86, round to 3)
# Curve 3: 49% density (step=2/0.49 ≈ 4.08, round to 4)
# Curve 4: 34% density (step=2/0.34 ≈ 5.88, round to 6)
# Curve 5: 24% density (step=2/0.24 ≈ 8.33, round to 8)
# Curve 6: 17% density (step=2/0.17 ≈ 11.8, round to 12)
# Curve 7: 12% density (step=2/0.12 ≈ 16.7, round to 16)

u_steps = [2, 2, 3, 4, 6, 8, 12, 16]

print("  Curve densities:")
for i, step in enumerate(u_steps):
    density = 2 / step * 100
    print(f"    Curve {i} (offset {base_log_offsets[i]:.1f}): step={step}, density={density:.0f}%")

for curve_idx, (base_log_off, u_step) in enumerate(zip(base_log_offsets, u_steps)):
    u_values = np.arange(2, 1980, u_step)

    for u in u_values:
        v_f = get_v_f_at_u(u)
        if v_f is None:
            continue

        log_off = get_log_v_offset(base_log_off, u)
        dv = 10 ** log_off
        v = v_f - dv
        if v > 0.0009:
            targets.append({'u': float(u), 'v': float(v), 'region': 'compressed_liquid', 'curve': curve_idx})

print(f"  {len(targets)} targets")

# Count per curve
for i in range(8):
    count = sum(1 for t in targets if t.get('curve') == i)
    print(f"    Curve {i}: {count} points")

print("\nSuperheated vapor targets:")
n_before = len(targets)

for v in np.logspace(np.log10(v_crit), np.log10(100), 50):
    u_g_min = u_g_from_v(v)
    if np.isnan(u_g_min):
        u_g_min = 2400
    u_start = u_g_min + 20
    u_end = 3300
    for u in np.arange(u_start, u_end, 20):
        if u > u_g_from_v(v) + 5:
            targets.append({'u': float(u), 'v': float(v), 'region': 'vapor'})

print(f"  {len(targets) - n_before} targets")

print("\nSupercritical targets:")
n_before = len(targets)

for u in np.arange(2000, 2800, 15):
    for v in np.logspace(np.log10(0.002), np.log10(v_crit), 20):
        if u < u_crit and v < v_crit * 0.8:
            continue
        targets.append({'u': float(u), 'v': float(v), 'region': 'supercritical'})

print(f"  {len(targets) - n_before} targets")

print(f"\nTotal targets: {len(targets)}")

print("\n" + "=" * 60)
print("Solving for T, P...")
print("=" * 60)

results = []
failed = []
start_time = time.time()
last_report = start_time

for i, target in enumerate(targets):
    now = time.time()
    if now - last_report > 10:
        elapsed = now - start_time
        pct = (i + 1) / len(targets) * 100
        print(f"  {i+1}/{len(targets)} ({pct:.1f}%), {len(results)} solved, {len(failed)} failed")
        last_report = now

    u, v, region = target['u'], target['v'], target['region']
    tp = find_TP_from_uv(u, v, region)

    if tp:
        result = {
            'u': u, 'v': v,
            'T_K': tp['T_K'], 'T_C': tp['T_C'], 'P_MPa': tp['P_MPa'],
            'region': region,
        }
        if 'curve' in target:
            result['curve'] = target['curve']
        results.append(result)
    else:
        failed.append(target)

elapsed = time.time() - start_time
print(f"\nCompleted in {elapsed:.1f}s")
print(f"Solved: {len(results)}")
print(f"Failed: {len(failed)}")

if failed:
    print("\nFailures by region:")
    for region in ['compressed_liquid', 'vapor', 'supercritical']:
        count = sum(1 for f in failed if f['region'] == region)
        if count > 0:
            print(f"  {region}: {count}")

output = {
    'description': 'Water properties on (u, v) grid - v13 with variable curve density',
    'n_points': len(results),
    'compressed_liquid_info': {
        'base_log_offsets': base_log_offsets.tolist(),
        'u_steps': u_steps,
        'scaling': 'Rate doubles at u=1000, 1200, 1400',
    },
    'saturation_filter': 'Removed index 274',
    'points': results,
}

output_path = Path(__file__).parent / 'uv_grid_data_v13.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"\nSaved to {output_path}")

print("\nPoints by region:")
for region in ['compressed_liquid', 'vapor', 'supercritical']:
    pts = [r for r in results if r['region'] == region]
    if pts:
        print(f"  {region}: {len(pts)}")
