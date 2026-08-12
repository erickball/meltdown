"""
Build a (u, v) grid - Version 5.

Improvements:
- Use scipy.optimize.root with hybr method (more robust than Newton)
- Better initial guess strategy using multiple starting points
- Focus on getting fine coverage near saturation
- Target spacing: ~1e-7 in v and ~2 kJ/kg in u near saturation at low T
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
from scipy.optimize import root, minimize_scalar
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
sat_P = np.array([pt['P_MPa'] for pt in sat_points])

T_crit = 647.096
P_crit = 22.064

def get_sat_at_T(T_K):
    """Get saturation properties at temperature T_K."""
    if T_K < sat_T[0] or T_K > sat_T[-1]:
        return None
    idx = np.searchsorted(sat_T, T_K)
    if idx == 0:
        idx = 1
    t = (T_K - sat_T[idx-1]) / (sat_T[idx] - sat_T[idx-1])
    return {
        'P': sat_P[idx-1] + t * (sat_P[idx] - sat_P[idx-1]),
        'u_f': sat_u_f[idx-1] + t * (sat_u_f[idx] - sat_u_f[idx-1]),
        'v_f': sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1]),
    }


def find_T_at_u(u_target):
    """Find saturation temperature at given u_f value."""
    if u_target < sat_u_f[0] or u_target > sat_u_f[-1]:
        return None
    idx = np.searchsorted(sat_u_f, u_target)
    if idx == 0:
        idx = 1
    t = (u_target - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
    return sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])


def find_TP_from_uv(u_target, v_target, T_init=None, P_init=None):
    """
    Find (T, P) that gives target (u, v).
    Uses scipy.optimize.root with hybr method.
    """
    def residual(x):
        T, P = x
        if T < 273.16 or T > 1073.15 or P < 1e-6 or P > 100:
            return [1e10, 1e10]
        try:
            water = IAPWS97(T=T, P=P)
            if water.u is None or water.v is None:
                return [1e10, 1e10]
            # Normalize residuals
            return [
                (water.u - u_target) / 10,  # ~10 kJ/kg scale
                (water.v - v_target) / v_target * 100  # Relative error * 100
            ]
        except:
            return [1e10, 1e10]

    # Try multiple initial guesses
    if T_init is None:
        T_sat = find_T_at_u(u_target)
        if T_sat:
            T_init = T_sat
        else:
            T_init = 400

    if P_init is None:
        sat = get_sat_at_T(T_init)
        if sat:
            P_init = sat['P'] * 1.5  # Above saturation for liquid
        else:
            P_init = 10

    initial_guesses = [
        (T_init, P_init),
        (T_init, P_init * 2),
        (T_init, P_init * 5),
        (T_init + 10, P_init),
        (T_init - 10, P_init),
        (400, 10),
        (500, 20),
        (350, 5),
    ]

    for T_try, P_try in initial_guesses:
        try:
            result = root(residual, [T_try, P_try], method='hybr', tol=1e-10)
            if result.success:
                T, P = result.x
                if 273.16 <= T <= 1073.15 and 1e-6 <= P <= 100:
                    # Verify
                    water = IAPWS97(T=T, P=P)
                    if water.u is not None and water.v is not None:
                        u_err = abs(water.u - u_target)
                        v_err = abs(water.v - v_target) / v_target
                        if u_err < 0.1 and v_err < 1e-6:
                            return {'T_K': T, 'P_MPa': P, 'u_check': water.u, 'v_check': water.v}
        except:
            pass

    return None


# Generate target (u, v) points with fine spacing near saturation
print("\n" + "=" * 60)
print("Generating target (u, v) grid with fine spacing near saturation")
print("=" * 60)

targets = []

# For compressed liquid: go through temperatures and generate points at various P > P_sat
print("\nGenerating compressed liquid targets by temperature...")

for T_C in np.concatenate([
    np.arange(1, 50, 1),       # Every 1°C from 1-50
    np.arange(50, 100, 1),     # Every 1°C from 50-100
    np.arange(100, 200, 2),    # Every 2°C from 100-200
    np.arange(200, 300, 3),    # Every 3°C from 200-300
    np.arange(300, 350, 2),    # Every 2°C from 300-350
    np.arange(350, 370, 1),    # Every 1°C from 350-370
    np.arange(370, 374, 0.5),  # Every 0.5°C near critical
]):
    T_K = T_C + 273.15
    sat = get_sat_at_T(T_K)
    if sat is None:
        continue

    P_sat = sat['P']
    u_sat = sat['u_f']
    v_sat = sat['v_f']

    # Pressures above saturation - denser near saturation
    # Very close to saturation
    P_near_sat = [P_sat * r for r in [1.001, 1.002, 1.005, 1.01, 1.02, 1.03, 1.05]]
    # Moderate
    P_moderate = [P_sat * r for r in [1.1, 1.2, 1.5, 2.0, 3.0]]
    # High P
    P_high = [P_sat * r for r in [5, 10, 20, 50] if P_sat * r <= 100]

    for P in P_near_sat + P_moderate + P_high:
        if P > 100:
            continue
        try:
            water = IAPWS97(T=T_K, P=P)
            if water.u is not None and water.v is not None:
                targets.append({
                    'u': water.u,
                    'v': water.v,
                    'T_init': T_K,
                    'P_init': P,
                    'region': 'compressed_liquid',
                })
        except:
            pass

print(f"  Generated {len(targets)} compressed liquid targets")

# Superheated vapor
print("\nGenerating superheated vapor targets...")
n_before = len(targets)

for T_C in np.concatenate([
    np.arange(100, 200, 5),
    np.arange(200, 400, 5),
    np.arange(400, 600, 10),
    np.arange(600, 800, 20),
]):
    T_K = T_C + 273.15
    sat = get_sat_at_T(T_K)

    if sat and T_K < T_crit:
        P_sat = sat['P']
        # Below saturation
        P_values = [P_sat * r for r in [0.99, 0.95, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0.01]]
    else:
        # Supercritical or above critical T
        P_values = np.logspace(-3, np.log10(50), 15)

    for P in P_values:
        if P < 1e-4:
            continue
        try:
            water = IAPWS97(T=T_K, P=P)
            if water.u is not None and water.v is not None:
                targets.append({
                    'u': water.u,
                    'v': water.v,
                    'T_init': T_K,
                    'P_init': P,
                    'region': 'vapor',
                })
        except:
            pass

print(f"  Generated {len(targets) - n_before} vapor targets")
print(f"\nTotal targets: {len(targets)}")

# Now we have targets with known (T, P) -> (u, v)
# The key insight: we already know T and P for these points!
# We don't need to solve the inverse problem.

# Let's directly store these as our grid points
results = []
for target in targets:
    results.append({
        'u': float(target['u']),
        'v': float(target['v']),
        'T_K': float(target['T_init']),
        'T_C': float(target['T_init'] - 273.15),
        'P_MPa': float(target['P_init']),
        'phase': target['region'],
    })

print(f"\nTotal grid points: {len(results)}")

# Save
output = {
    'description': 'Water properties grid - forward generation with fine T spacing',
    'n_points': len(results),
    'points': results,
}

output_path = Path(__file__).parent / 'uv_grid_data_v5.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"Saved to {output_path}")

# Now the question: is this grid suitable for (u, v) lookups?
# The points are NOT on a regular (u, v) grid, but they are generated
# at regular T intervals with various P values.

# Let's analyze the spacing in (u, v) space
u_arr = np.array([pt['u'] for pt in results if pt['phase'] == 'compressed_liquid'])
v_arr = np.array([pt['v'] for pt in results if pt['phase'] == 'compressed_liquid'])

print("\nCompressed liquid (u, v) spacing analysis:")

# Sort by u
sort_idx = np.argsort(u_arr)
u_sorted = u_arr[sort_idx]
v_sorted = v_arr[sort_idx]

# Find unique u values (approximately)
u_unique = []
v_at_u = {}
for u, v in zip(u_sorted, v_sorted):
    u_round = round(u, 1)
    if u_round not in v_at_u:
        v_at_u[u_round] = []
        u_unique.append(u_round)
    v_at_u[u_round].append(v)

u_unique = np.array(sorted(u_unique))
u_diffs = np.diff(u_unique)

print(f"  Number of unique u values: {len(u_unique)}")
print(f"  u range: {u_unique.min():.1f} to {u_unique.max():.1f} kJ/kg")
print(f"  u spacing: min={u_diffs.min():.2f}, max={u_diffs.max():.2f}, mean={u_diffs.mean():.2f} kJ/kg")

# V spacing at a few u values
print("\n  V spacing at selected u values:")
for u_check in [100, 200, 500, 1000, 1500]:
    if u_check in v_at_u:
        v_vals = sorted(v_at_u[u_check])
        if len(v_vals) > 1:
            v_diffs = np.diff(v_vals)
            print(f"    u={u_check}: {len(v_vals)} points, v_spacing min={v_diffs.min():.2e}, max={v_diffs.max():.2e}")
