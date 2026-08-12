"""
Build (u, v) grid - Version 7.

Key fix: Properly exclude invalid thermodynamic states by checking against
the saturation dome boundary. For vapor, we need u > u_g(v).
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
from scipy.optimize import root
from scipy.interpolate import LinearNDInterpolator, interp1d
import time

# Load saturation dome
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
print(f"Loaded {len(sat_points)} saturation points")

sat_T = np.array([pt['T_K'] for pt in sat_points])
sat_u_f = np.array([pt['u_f'] for pt in sat_points])
sat_v_f = np.array([pt['v_f'] for pt in sat_points])
sat_u_g = np.array([pt['u_g'] for pt in sat_points])
sat_v_g = np.array([pt['v_g'] for pt in sat_points])
sat_P = np.array([pt['P_MPa'] for pt in sat_points])

T_crit = 647.096
P_crit = 22.064
u_crit = sat_u_f[-1]  # At critical, u_f = u_g
v_crit = sat_v_f[-1]

print(f"Critical point: T={T_crit-273.15:.2f}C, u={u_crit:.1f} kJ/kg, v={v_crit:.6f} m³/kg")

# Build interpolators for saturation boundary
# Liquid line: u_f(v_f) - but v_f is not monotonic near critical, use T as parameter
# Vapor line: u_g(v_g) - v_g is monotonic (decreasing with T)

# For vapor line, create u_g(v) interpolator (v_g decreases with T, so it's unique)
# Sort by v_g ascending
vg_sort_idx = np.argsort(sat_v_g)
vg_sorted = sat_v_g[vg_sort_idx]
ug_sorted = sat_u_g[vg_sort_idx]
Tg_sorted = sat_T[vg_sort_idx]
Pg_sorted = sat_P[vg_sort_idx]

# Interpolator: given v, get u_g (minimum u for vapor at that v)
u_g_from_v = interp1d(vg_sorted, ug_sorted, bounds_error=False, fill_value=(ug_sorted[0], ug_sorted[-1]))
T_g_from_v = interp1d(vg_sorted, Tg_sorted, bounds_error=False, fill_value=(Tg_sorted[0], Tg_sorted[-1]))

# For liquid line, v_f increases with T (mostly monotonic)
vf_sort_idx = np.argsort(sat_v_f)
vf_sorted = sat_v_f[vf_sort_idx]
uf_sorted = sat_u_f[vf_sort_idx]
Tf_sorted = sat_T[vf_sort_idx]

# Interpolator: given v, get u_f (maximum u for liquid at that v)
u_f_from_v = interp1d(vf_sorted, uf_sorted, bounds_error=False, fill_value=(uf_sorted[0], uf_sorted[-1]))


def is_valid_vapor(u, v):
    """Check if (u, v) is a valid superheated vapor state (not in two-phase)."""
    if v < v_crit:
        return False  # v too small for vapor (would be liquid or supercritical)
    if v > sat_v_g[0]:  # v_g at triple point is max
        # Very low pressure, check if u is reasonable
        u_g_min = u_g_from_v(v)
        return u >= u_g_min
    # Normal range
    u_g_at_v = u_g_from_v(v)
    return u >= u_g_at_v


def is_valid_liquid(u, v):
    """Check if (u, v) is a valid compressed liquid state."""
    if v > v_crit:
        return False  # v too large for liquid
    if v < 0.0009:
        return False  # Below physical limit
    u_f_at_v = u_f_from_v(v)
    return u <= u_f_at_v


def get_v_f_at_u(u):
    """Get v_f at given u_f value."""
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])


def get_T_sat_at_u_f(u):
    """Get T_sat at given u_f value."""
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])


# Load v5 data for initial guesses
v5_path = Path(__file__).parent / 'uv_grid_data_v5.json'
with open(v5_path, 'r') as f:
    v5_data = json.load(f)

v5_points = v5_data['points']
print(f"Loaded {len(v5_points)} reference points")

v5_u = np.array([pt['u'] for pt in v5_points])
v5_v = np.array([pt['v'] for pt in v5_points])
v5_T = np.array([pt['T_K'] for pt in v5_points])
v5_P = np.array([pt['P_MPa'] for pt in v5_points])
v5_logv = np.log10(v5_v)

coords = np.column_stack([v5_u, v5_logv])
T_interp = LinearNDInterpolator(coords, v5_T, fill_value=np.nan)
P_interp = LinearNDInterpolator(coords, v5_P, fill_value=np.nan)


def get_initial_guess(u, v, region):
    """Get initial (T, P) guess."""
    logv = np.log10(v)
    T_guess = T_interp(u, logv)
    P_guess = P_interp(u, logv)

    if not np.isnan(T_guess) and not np.isnan(P_guess):
        return float(T_guess), float(P_guess)

    # Fallback heuristics
    if region == 'compressed_liquid':
        T_sat = get_T_sat_at_u_f(u)
        if T_sat:
            return float(T_sat), 20.0
        return 400.0, 20.0
    elif region == 'vapor':
        # For vapor, use saturation T at this v as starting point
        T_sat = T_g_from_v(v)
        if not np.isnan(T_sat):
            return float(T_sat) + 50, 0.5  # Slightly superheated
        return 450.0, 0.5
    else:  # supercritical
        return 700.0, 30.0


def find_TP_from_uv(u_target, v_target, region, max_attempts=8):
    """Find (T, P) that produces the target (u, v)."""
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

    # Generate multiple guesses
    guesses = [(T_init, P_init)]

    if region == 'compressed_liquid':
        guesses += [
            (T_init, P_init * 2),
            (T_init, P_init * 0.5),
            (T_init + 20, P_init),
            (T_init - 20, P_init),
        ]
    elif region == 'vapor':
        # For vapor, try a range of low pressures
        guesses += [
            (T_init + 50, P_init),
            (T_init - 50, P_init),
            (T_init, P_init * 2),
            (T_init, P_init * 0.5),
            (400, 0.1),
            (500, 0.5),
            (600, 1.0),
        ]
    else:  # supercritical
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


# Generate targets with proper validity checking
print("\n" + "=" * 60)
print("Generating targets with validity checking")
print("=" * 60)

targets = []

# Compressed liquid (same as v6)
print("\nCompressed liquid targets:")
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
        if v > 0.0009 and is_valid_liquid(u, v):
            targets.append({'u': float(u), 'v': float(v), 'region': 'compressed_liquid'})

print(f"  {len(targets)} targets")

# Superheated vapor - only include valid states
print("\nSuperheated vapor targets:")
n_before = len(targets)

# Generate on (u, v) grid but filter for validity
# u should be above u_g at the given v
for v in np.logspace(np.log10(0.005), np.log10(100), 50):
    # Get minimum u (u_g at this v)
    u_g_min = u_g_from_v(v)
    if np.isnan(u_g_min):
        u_g_min = 2400  # Fallback

    # u values above saturation
    u_start = max(u_g_min + 10, 2400)  # At least 10 kJ/kg above saturation
    u_end = 3300

    for u in np.arange(u_start, u_end, 20):
        if is_valid_vapor(u, v):
            targets.append({'u': float(u), 'v': float(v), 'region': 'vapor'})

print(f"  {len(targets) - n_before} targets")

# Supercritical - be more careful about the region
print("\nSupercritical targets:")
n_before = len(targets)

# Supercritical is T > T_crit AND P > P_crit
# In (u, v) space, this is roughly u > u_crit and v around v_crit
for u in np.arange(2000, 2800, 15):
    for v in np.logspace(np.log10(0.002), np.log10(0.015), 20):
        # Skip if clearly in two-phase or liquid
        if v < v_crit * 0.5 and u < u_crit:
            continue  # Likely liquid
        if v > v_crit * 2 and u < 2400:
            continue  # Likely two-phase
        targets.append({'u': float(u), 'v': float(v), 'region': 'supercritical'})

print(f"  {len(targets) - n_before} targets")

print(f"\nTotal targets: {len(targets)}")

# Solve
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
        results.append({
            'u': u, 'v': v,
            'T_K': tp['T_K'], 'T_C': tp['T_C'], 'P_MPa': tp['P_MPa'],
            'region': region,
        })
    else:
        failed.append(target)

elapsed = time.time() - start_time
print(f"\nCompleted in {elapsed:.1f}s")
print(f"Solved: {len(results)}")
print(f"Failed: {len(failed)}")

# Failure analysis
if failed:
    print("\nFailures by region:")
    for region in ['compressed_liquid', 'vapor', 'supercritical']:
        count = sum(1 for f in failed if f['region'] == region)
        if count > 0:
            print(f"  {region}: {count}")

# Save
output = {
    'description': 'Water properties on (u, v) grid with validity checking',
    'n_points': len(results),
    'points': results,
}

output_path = Path(__file__).parent / 'uv_grid_data_v7.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"\nSaved to {output_path}")

# Summary
print("\nPoints by region:")
for region in ['compressed_liquid', 'vapor', 'supercritical']:
    pts = [r for r in results if r['region'] == region]
    if pts:
        print(f"  {region}: {len(pts)}")
