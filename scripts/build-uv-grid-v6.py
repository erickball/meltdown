"""
Build a true (u, v) grid - Version 6.

Strategy:
1. Define target (u, v) grid points with desired spacing
2. For each target, use forward data to get initial (T, P) guess
3. Refine with scipy.optimize to find exact (T, P)

The key is that we want points on a REGULAR (u, v) grid for fast lookup.
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
from scipy.optimize import root, minimize
from scipy.interpolate import LinearNDInterpolator
import time

# Load forward-generated data (v5) for initial guesses
v5_path = Path(__file__).parent / 'uv_grid_data_v5.json'
with open(v5_path, 'r') as f:
    v5_data = json.load(f)

v5_points = v5_data['points']
print(f"Loaded {len(v5_points)} forward-generated points")

# Build interpolators for T(u,v) and P(u,v) from forward data
v5_u = np.array([pt['u'] for pt in v5_points])
v5_v = np.array([pt['v'] for pt in v5_points])
v5_T = np.array([pt['T_K'] for pt in v5_points])
v5_P = np.array([pt['P_MPa'] for pt in v5_points])

# Use log(v) for better interpolation across orders of magnitude
v5_logv = np.log10(v5_v)

print("Building interpolators for initial guesses...")
coords = np.column_stack([v5_u, v5_logv])

# Build triangulation-based interpolators
try:
    T_interp = LinearNDInterpolator(coords, v5_T, fill_value=np.nan)
    P_interp = LinearNDInterpolator(coords, v5_P, fill_value=np.nan)
    print("  Interpolators built successfully")
except Exception as e:
    print(f"  Interpolator failed: {e}")
    T_interp = None
    P_interp = None

# Load saturation data
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
sat_T = np.array([pt['T_K'] for pt in sat_points])
sat_u_f = np.array([pt['u_f'] for pt in sat_points])
sat_v_f = np.array([pt['v_f'] for pt in sat_points])
sat_P = np.array([pt['P_MPa'] for pt in sat_points])

T_crit = 647.096
P_crit = 22.064


def get_initial_guess(u, v):
    """Get initial (T, P) guess from interpolators or heuristics."""
    logv = np.log10(v)

    # Try interpolator first
    if T_interp is not None:
        T_guess = T_interp(u, logv)
        P_guess = P_interp(u, logv)
        if not np.isnan(T_guess) and not np.isnan(P_guess):
            return float(T_guess), float(P_guess)

    # Heuristic fallback
    # For compressed liquid (small v), estimate T from u
    if v < 0.01:
        # u ≈ 4.18 * (T - 273) for liquid water roughly
        T_guess = 273.15 + u / 4.2
        T_guess = min(max(T_guess, 280), 640)
        P_guess = 20  # High pressure for liquid
    else:
        # Vapor - rough ideal gas estimate
        T_guess = 400 + u / 5
        T_guess = min(max(T_guess, 350), 800)
        P_guess = 0.5
    return T_guess, P_guess


def find_TP_from_uv(u_target, v_target, max_attempts=5):
    """
    Find (T, P) that produces the target (u, v).
    Returns dict with T_K, P_MPa, or None if failed.
    """
    def objective(x):
        T, P = x
        if T < 273.16 or T > 1000 or P < 1e-6 or P > 100:
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

    T_init, P_init = get_initial_guess(u_target, v_target)

    # Multiple attempts with perturbed initial guesses
    guesses = [
        (T_init, P_init),
        (T_init * 1.05, P_init),
        (T_init * 0.95, P_init),
        (T_init, P_init * 1.5),
        (T_init, P_init * 0.7),
    ]

    for T_try, P_try in guesses[:max_attempts]:
        try:
            result = root(objective, [T_try, P_try], method='hybr', tol=1e-10)
            if result.success:
                T, P = result.x
                if 273.16 <= T <= 1000 and 1e-6 <= P <= 100:
                    water = IAPWS97(T=T, P=P)
                    if water.u is not None and water.v is not None:
                        u_err = abs(water.u - u_target)
                        v_err = abs(water.v - v_target) / v_target
                        if u_err < 0.1 and v_err < 1e-5:
                            return {
                                'T_K': float(T),
                                'T_C': float(T - 273.15),
                                'P_MPa': float(P),
                            }
        except:
            pass

    return None


# Define target (u, v) grid
print("\n" + "=" * 60)
print("Defining target (u, v) grid")
print("=" * 60)

# For compressed liquid, we want:
# - u spacing: 2 kJ/kg near saturation at low T, can increase at high T
# - v spacing: 1e-7 very near saturation, increasing away

# The challenge: we don't know v_f(u) exactly, we need to compute it

# Get saturation curve as function of u
def get_v_f_at_u(u):
    """Get v_f at given u value."""
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])


def get_T_sat_at_u(u):
    """Get T_sat at given u value."""
    if u < sat_u_f[0] or u > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u)
    if idx == 0:
        idx = 1
    t = (u - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])


# Generate grid targets
targets = []

# Compressed liquid
print("\nCompressed liquid targets:")

# u values with adaptive spacing
u_values_liq = np.concatenate([
    np.arange(0, 400, 2),     # 2 kJ/kg spacing, 0-400 (low T)
    np.arange(400, 800, 3),   # 3 kJ/kg spacing, 400-800
    np.arange(800, 1200, 5),  # 5 kJ/kg spacing, 800-1200
    np.arange(1200, 1600, 8), # 8 kJ/kg spacing, 1200-1600
    np.arange(1600, 1950, 10),# 10 kJ/kg spacing, near critical
])

for u in u_values_liq:
    v_f = get_v_f_at_u(u)
    if v_f is None:
        continue

    # v offsets from saturation (negative = compressed)
    # Denser near saturation
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
        if v > 0.0009:  # Minimum physically reasonable v
            targets.append({'u': float(u), 'v': float(v), 'region': 'compressed_liquid'})

print(f"  {len(targets)} targets")

# Superheated vapor
print("\nSuperheated vapor targets:")
n_before = len(targets)

# For vapor, use regular (u, v) grid in log-v space
u_values_vap = np.arange(2300, 3300, 20)
v_values_vap = np.logspace(np.log10(0.01), np.log10(100), 40)

for u in u_values_vap:
    for v in v_values_vap:
        # Skip if inside dome (roughly)
        if v < 0.1 and u < 2600:
            continue
        targets.append({'u': float(u), 'v': float(v), 'region': 'vapor'})

print(f"  {len(targets) - n_before} targets")

# Supercritical
print("\nSupercritical targets:")
n_before = len(targets)

u_values_sc = np.arange(1900, 2600, 20)
v_values_sc = np.logspace(np.log10(0.003), np.log10(0.02), 20)

for u in u_values_sc:
    for v in v_values_sc:
        targets.append({'u': float(u), 'v': float(v), 'region': 'supercritical'})

print(f"  {len(targets) - n_before} targets")

print(f"\nTotal targets: {len(targets)}")

# Solve for (T, P) at each target
print("\n" + "=" * 60)
print("Solving for T, P at each target...")
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
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta = (len(targets) - i - 1) / rate if rate > 0 else 0
        print(f"  {i+1}/{len(targets)} ({pct:.1f}%), {len(results)} solved, {len(failed)} failed, ETA {eta:.0f}s")
        last_report = now

    u, v = target['u'], target['v']
    tp = find_TP_from_uv(u, v)

    if tp:
        results.append({
            'u': u,
            'v': v,
            'T_K': tp['T_K'],
            'T_C': tp['T_C'],
            'P_MPa': tp['P_MPa'],
            'region': target['region'],
        })
    else:
        failed.append(target)

elapsed = time.time() - start_time
print(f"\nCompleted in {elapsed:.1f}s")
print(f"Solved: {len(results)}")
print(f"Failed: {len(failed)}")

# Analyze failures
if failed:
    regions = {}
    for f in failed:
        r = f['region']
        regions[r] = regions.get(r, 0) + 1
    print("\nFailures by region:")
    for r, c in regions.items():
        print(f"  {r}: {c}")

# Save results
output = {
    'description': 'Water properties on true (u, v) grid',
    'n_points': len(results),
    'points': results,
}

output_path = Path(__file__).parent / 'uv_grid_data_v6.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"\nSaved to {output_path}")

# Analyze spacing
print("\n" + "=" * 60)
print("Grid spacing analysis")
print("=" * 60)

liq_results = [r for r in results if r['region'] == 'compressed_liquid']
if liq_results:
    u_liq = np.array([r['u'] for r in liq_results])
    v_liq = np.array([r['v'] for r in liq_results])

    # Group by u
    u_unique = np.unique(u_liq)
    print(f"\nCompressed liquid: {len(liq_results)} points at {len(u_unique)} unique u values")

    # Check v spacing at a few u values
    print("\nV spacing near saturation:")
    for u_check in [100, 200, 400]:
        mask = np.abs(u_liq - u_check) < 1
        if np.any(mask):
            v_at_u = np.sort(v_liq[mask])
            v_f = get_v_f_at_u(u_check)
            if len(v_at_u) > 1 and v_f:
                offsets = v_f - v_at_u
                print(f"  u={u_check}: {len(v_at_u)} points, closest to sat: {offsets.min():.2e}, farthest: {offsets.max():.2e}")
