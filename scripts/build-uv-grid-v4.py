"""
Build a (u, v) grid for water property lookups - Version 4.

Generate points on a true (u, v) grid with adaptive density:
- Denser near saturation (both in u and v)
- Sparser far from saturation
- Skip two-phase region

Use forward-generated data (v3) to build a KD-tree for initial guesses,
then Newton-iterate to find exact (T, P) for each target (u, v).
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
from scipy.spatial import cKDTree
from scipy.optimize import fsolve
import time

# Load saturation dome from IAPWS
dome_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(dome_path, 'r') as f:
    dome_data = json.load(f)

sat_points = dome_data['raw_data']
print(f"Loaded {len(sat_points)} saturation points")

# Build saturation curves as arrays
sat_T = np.array([pt['T_K'] for pt in sat_points])
sat_u_f = np.array([pt['u_f'] for pt in sat_points])
sat_v_f = np.array([pt['v_f'] for pt in sat_points])
sat_u_g = np.array([pt['u_g'] for pt in sat_points])
sat_v_g = np.array([pt['v_g'] for pt in sat_points])
sat_P = np.array([pt['P_MPa'] for pt in sat_points])

# Critical point
u_crit = dome_data['critical_point']['u_c']
v_crit = dome_data['critical_point']['v_c']
T_crit = dome_data['critical_point']['T_K']
P_crit = dome_data['critical_point']['P_MPa']

print(f"Critical point: u={u_crit:.1f} kJ/kg, v={v_crit:.6f} m³/kg")


def get_saturation_at_u(u_target):
    """
    Get saturation properties at a given u value.
    Returns (T_K, P_MPa, v_f, v_g) or None if u is outside range.
    """
    # Check liquid line (u_f increases monotonically with T)
    if sat_u_f[0] <= u_target <= sat_u_f[-1]:
        # Interpolate on liquid line
        idx = np.searchsorted(sat_u_f, u_target)
        if idx == 0:
            idx = 1
        if idx >= len(sat_u_f):
            idx = len(sat_u_f) - 1

        # Linear interpolation
        t = (u_target - sat_u_f[idx-1]) / (sat_u_f[idx] - sat_u_f[idx-1])
        T = sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])
        P = sat_P[idx-1] + t * (sat_P[idx] - sat_P[idx-1])
        v_f = sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])
        v_g = sat_v_g[idx-1] + t * (sat_v_g[idx] - sat_v_g[idx-1])
        return (T, P, v_f, v_g, 'liquid')

    # Check vapor line (u_g is NOT monotonic - has a max around 237 C)
    u_g_max_idx = np.argmax(sat_u_g)

    # Ascending branch (low T, u_g goes from ~2375 to ~2603)
    if sat_u_g[0] <= u_target <= sat_u_g[u_g_max_idx]:
        u_g_asc = sat_u_g[:u_g_max_idx+1]
        idx = np.searchsorted(u_g_asc, u_target)
        if idx == 0:
            idx = 1
        if idx >= len(u_g_asc):
            idx = len(u_g_asc) - 1

        t = (u_target - sat_u_g[idx-1]) / (sat_u_g[idx] - sat_u_g[idx-1])
        T = sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])
        P = sat_P[idx-1] + t * (sat_P[idx] - sat_P[idx-1])
        v_f = sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])
        v_g = sat_v_g[idx-1] + t * (sat_v_g[idx] - sat_v_g[idx-1])
        return (T, P, v_f, v_g, 'vapor_asc')

    # Descending branch (high T near critical, u_g goes from ~2603 to ~2056)
    if sat_u_g[-1] <= u_target <= sat_u_g[u_g_max_idx]:
        u_g_desc = sat_u_g[u_g_max_idx:]
        # This is decreasing, so search in reverse
        u_g_desc_rev = u_g_desc[::-1]
        idx_rev = np.searchsorted(u_g_desc_rev, u_target)
        idx = len(u_g_desc) - 1 - idx_rev + u_g_max_idx

        if idx <= u_g_max_idx:
            idx = u_g_max_idx + 1
        if idx >= len(sat_u_g):
            idx = len(sat_u_g) - 1

        t = (u_target - sat_u_g[idx-1]) / (sat_u_g[idx] - sat_u_g[idx-1]) if sat_u_g[idx] != sat_u_g[idx-1] else 0
        T = sat_T[idx-1] + t * (sat_T[idx] - sat_T[idx-1])
        P = sat_P[idx-1] + t * (sat_P[idx] - sat_P[idx-1])
        v_f = sat_v_f[idx-1] + t * (sat_v_f[idx] - sat_v_f[idx-1])
        v_g = sat_v_g[idx-1] + t * (sat_v_g[idx] - sat_v_g[idx-1])
        return (T, P, v_f, v_g, 'vapor_desc')

    return None


def is_two_phase(u, v):
    """
    Check if (u, v) is inside the two-phase region.
    Returns True if inside the saturation dome.
    """
    # Find saturation at this u
    sat = get_saturation_at_u(u)
    if sat is None:
        return False  # Outside u range of dome

    T, P, v_f, v_g, branch = sat

    # Inside dome if v_f < v < v_g
    if v_f < v < v_g:
        return True

    return False


def is_compressed_liquid(u, v):
    """Check if point is in compressed liquid region (v < v_f at same u)."""
    sat = get_saturation_at_u(u)
    if sat is None:
        # Could still be compressed liquid at very low u
        if u < sat_u_f[0] and v < 0.002:
            return True
        return False

    T, P, v_f, v_g, branch = sat
    return v < v_f


def is_superheated_vapor(u, v):
    """Check if point is in superheated vapor region (v > v_g at same u)."""
    sat = get_saturation_at_u(u)
    if sat is None:
        # Could be superheated at high u
        if u > sat_u_g[-1] and v > 0.003:
            return True
        return False

    T, P, v_f, v_g, branch = sat
    return v > v_g


# Load v3 data for initial guesses
v3_path = Path(__file__).parent / 'uv_grid_data_v3.json'
with open(v3_path, 'r') as f:
    v3_data = json.load(f)

v3_points = v3_data['points']
print(f"Loaded {len(v3_points)} reference points from v3")

# Build KD-tree for fast nearest-neighbor lookup
# Normalize u and v to similar scales for distance calculation
u_scale = 100  # u ranges ~0-3000
v_scale = 0.01  # v ranges ~0.001-100 (log scale)

v3_uv = np.array([[pt['u'] / u_scale, np.log10(pt['v']) / 2] for pt in v3_points])
v3_tree = cKDTree(v3_uv)

def get_initial_guess(u, v):
    """Get initial (T, P) guess from nearest v3 point."""
    query = [u / u_scale, np.log10(v) / 2]
    dist, idx = v3_tree.query(query, k=3)

    # Use closest point
    pt = v3_points[idx[0]]
    return pt['T_K'], pt['P_MPa']


def find_TP_from_uv(u_target, v_target, T_init=None, P_init=None, tol=1e-8, max_iter=30):
    """
    Find (T, P) that gives target (u, v) using Newton iteration.
    """
    if T_init is None or P_init is None:
        T_init, P_init = get_initial_guess(u_target, v_target)

    T, P = T_init, P_init

    for iteration in range(max_iter):
        try:
            water = IAPWS97(T=T, P=P)
            if water.u is None or water.v is None:
                return None

            u_calc = water.u
            v_calc = water.v

            # Check convergence
            u_err = abs(u_calc - u_target)
            v_err = abs(v_calc - v_target) / v_target

            if u_err < 0.01 and v_err < tol:  # u within 0.01 kJ/kg, v within tol relative
                # Determine phase
                if T > T_crit and P > P_crit:
                    phase = 'supercritical'
                elif is_compressed_liquid(u_target, v_target):
                    phase = 'compressed_liquid'
                else:
                    phase = 'superheated_vapor'

                return {
                    'T_K': float(T),
                    'T_C': float(T - 273.15),
                    'P_MPa': float(P),
                    'u': float(u_target),
                    'v': float(v_target),
                    'u_check': float(u_calc),
                    'v_check': float(v_calc),
                    'phase': phase,
                }

            # Newton update - numerical Jacobian
            dT = 0.01  # K
            dP = P * 1e-6 + 1e-6  # Small relative perturbation

            water_dT = IAPWS97(T=T+dT, P=P)
            water_dP = IAPWS97(T=T, P=P+dP)

            if water_dT.u is None or water_dP.u is None:
                return None

            du_dT = (water_dT.u - u_calc) / dT
            du_dP = (water_dP.u - u_calc) / dP
            dv_dT = (water_dT.v - v_calc) / dT
            dv_dP = (water_dP.v - v_calc) / dP

            # Solve J * [dT, dP] = -[f_u, f_v]
            det = du_dT * dv_dP - du_dP * dv_dT
            if abs(det) < 1e-30:
                return None

            f_u = u_calc - u_target
            f_v = v_calc - v_target

            delta_T = -(dv_dP * f_u - du_dP * f_v) / det
            delta_P = -(-dv_dT * f_u + du_dT * f_v) / det

            # Damping
            max_dT = 20
            max_dP = P * 0.3

            delta_T = np.clip(delta_T, -max_dT, max_dT)
            delta_P = np.clip(delta_P, -max_dP, max_dP)

            T = T + delta_T
            P = P + delta_P

            # Bounds
            T = np.clip(T, 273.16, 1073.15)
            P = np.clip(P, 1e-6, 100)

        except Exception as e:
            return None

    return None  # Did not converge


# Generate adaptive (u, v) grid
print("\n" + "=" * 60)
print("Generating adaptive (u, v) grid...")
print("=" * 60)

def generate_adaptive_grid():
    """
    Generate (u, v) target points with adaptive density.
    Denser near saturation, sparser away from it.
    """
    points = []

    # For compressed liquid: u from -10 to ~2000, v from 0.0009 to v_f
    # Near saturation: fine spacing in both u and v
    # Far from saturation (high P): coarser spacing

    print("\nGenerating compressed liquid points...")

    # Temperature-based sampling for compressed liquid
    for T_C in np.concatenate([
        np.arange(0, 100, 2),      # Every 2 C below 100
        np.arange(100, 200, 5),    # Every 5 C, 100-200
        np.arange(200, 300, 5),    # Every 5 C, 200-300
        np.arange(300, 360, 3),    # Every 3 C, 300-360
        np.arange(360, 374, 1),    # Every 1 C near critical
    ]):
        T_K = T_C + 273.15

        # Get saturation at this T
        idx = np.searchsorted(sat_T, T_K)
        if idx >= len(sat_T):
            continue

        u_sat = sat_u_f[idx]
        v_sat = sat_v_f[idx]
        P_sat = sat_P[idx]

        # Generate points at various pressures above saturation
        # Dense near saturation, sparse at high P
        P_ratios = [1.01, 1.02, 1.05, 1.1, 1.2, 1.5, 2, 3, 5, 10, 20]

        for P_ratio in P_ratios:
            P = P_sat * P_ratio
            if P > 100:
                continue

            try:
                water = IAPWS97(T=T_K, P=P)
                if water.u is not None and water.v is not None:
                    u = water.u
                    v = water.v

                    # Skip if in two-phase (shouldn't happen for P > P_sat)
                    if not is_two_phase(u, v):
                        points.append((u, v, T_K, P))
            except:
                pass

    print(f"  Generated {len(points)} compressed liquid points")

    # For superheated vapor: u from ~2000 to 3300, v from v_g to 100+
    print("\nGenerating superheated vapor points...")

    n_vapor_before = len(points)

    for T_C in np.concatenate([
        np.arange(50, 200, 10),    # Every 10 C, 50-200
        np.arange(200, 400, 5),    # Every 5 C, 200-400
        np.arange(400, 600, 10),   # Every 10 C, 400-600
    ]):
        T_K = T_C + 273.15

        # Get saturation at this T (if subcritical)
        idx = np.searchsorted(sat_T, T_K)
        if idx < len(sat_T):
            P_sat = sat_P[idx]
        else:
            P_sat = P_crit

        # Pressures below saturation
        if T_K < T_crit:
            P_max = P_sat * 0.99
        else:
            P_max = 50  # Supercritical

        P_values = np.logspace(np.log10(0.001), np.log10(P_max), 25)

        for P in P_values:
            try:
                water = IAPWS97(T=T_K, P=P)
                if water.u is not None and water.v is not None:
                    u = water.u
                    v = water.v

                    if not is_two_phase(u, v):
                        points.append((u, v, T_K, P))
            except:
                pass

    print(f"  Generated {len(points) - n_vapor_before} vapor/supercritical points")

    return points


# Generate initial points (these have known T, P)
initial_points = generate_adaptive_grid()
print(f"\nTotal initial points: {len(initial_points)}")

# Now create a true (u, v) grid by selecting target u, v values
# and solving for T, P

print("\n" + "=" * 60)
print("Building true (u, v) grid with Newton iteration...")
print("=" * 60)

# Get u, v ranges from initial points
u_init = np.array([pt[0] for pt in initial_points])
v_init = np.array([pt[1] for pt in initial_points])

print(f"Initial u range: {u_init.min():.1f} to {u_init.max():.1f} kJ/kg")
print(f"Initial v range: {v_init.min():.6f} to {v_init.max():.2f} m³/kg")

# Define target (u, v) grid with adaptive spacing

# For compressed liquid (low v):
# u: from near 0 to ~1800 kJ/kg with spacing ~2 kJ/kg near saturation
# v: from 0.0009 to 0.003 with spacing ~1e-7 near saturation increasing away

# For vapor (high v):
# u: from ~2300 to 3300 kJ/kg with spacing ~10 kJ/kg
# v: from 0.003 to 100 (log scale) with moderate spacing

def generate_target_grid():
    """Generate target (u, v) points for the final grid."""
    targets = []

    # Compressed liquid region
    print("\nDefining compressed liquid grid targets...")

    # Near saturation: fine grid
    # u from 0 to 800 in steps of 2, v from v_f - eps to v_f - 10*eps
    for u in np.arange(0, 800, 2):
        sat = get_saturation_at_u(u)
        if sat is None:
            continue
        T_sat, P_sat, v_f, v_g, _ = sat

        # v slightly below saturation
        for v_offset in [1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4]:
            v = v_f - v_offset
            if v > 0.0009:
                targets.append((u, v, 'compressed_liquid_near_sat'))

    # u from 800 to 1600 in steps of 5
    for u in np.arange(800, 1600, 5):
        sat = get_saturation_at_u(u)
        if sat is None:
            continue
        T_sat, P_sat, v_f, v_g, _ = sat

        for v_offset in [1e-7, 5e-7, 2e-6, 1e-5, 5e-5, 2e-4]:
            v = v_f - v_offset
            if v > 0.0009:
                targets.append((u, v, 'compressed_liquid_near_sat'))

    # u from 1600 to 2000 in steps of 10 (near critical)
    for u in np.arange(1600, 2000, 10):
        sat = get_saturation_at_u(u)
        if sat is None:
            continue
        T_sat, P_sat, v_f, v_g, _ = sat

        for v_offset in [1e-6, 1e-5, 1e-4, 5e-4]:
            v = v_f - v_offset
            if v > 0.0009:
                targets.append((u, v, 'compressed_liquid_near_sat'))

    # Far from saturation (high P compressed liquid)
    for u in np.arange(0, 1500, 20):
        for v in np.linspace(0.00095, 0.00098, 5):
            targets.append((u, v, 'compressed_liquid_high_P'))

    print(f"  {len(targets)} compressed liquid targets")

    # Superheated vapor region
    print("\nDefining superheated vapor grid targets...")
    n_before = len(targets)

    # Near saturation
    for u in np.arange(2380, 2600, 5):
        sat = get_saturation_at_u(u)
        if sat is None:
            continue
        T_sat, P_sat, v_f, v_g, _ = sat

        for v_mult in [1.001, 1.002, 1.005, 1.01, 1.02, 1.05, 1.1, 1.2]:
            v = v_g * v_mult
            if v < 200:
                targets.append((u, v, 'superheated_near_sat'))

    # Away from saturation
    for u in np.arange(2400, 3200, 20):
        for v in np.logspace(np.log10(0.01), np.log10(100), 20):
            if not is_two_phase(u, v):
                targets.append((u, v, 'superheated_vapor'))

    print(f"  {len(targets) - n_before} superheated vapor targets")

    # Supercritical region
    print("\nDefining supercritical grid targets...")
    n_before = len(targets)

    for u in np.arange(2000, 2800, 20):
        for v in np.logspace(np.log10(0.002), np.log10(0.02), 15):
            if not is_two_phase(u, v):
                targets.append((u, v, 'supercritical'))

    print(f"  {len(targets) - n_before} supercritical targets")

    return targets


target_points = generate_target_grid()
print(f"\nTotal target points: {len(target_points)}")

# Solve for T, P at each target
results = []
failed = 0
start_time = time.time()
last_report = start_time

for i, (u, v, region) in enumerate(target_points):
    now = time.time()
    if now - last_report > 10:
        elapsed = now - start_time
        pct = (i + 1) / len(target_points) * 100
        print(f"  {i+1}/{len(target_points)} ({pct:.1f}%), {len(results)} solved, {failed} failed, {elapsed:.0f}s")
        last_report = now

    result = find_TP_from_uv(u, v)

    if result:
        result['region'] = region
        results.append(result)
    else:
        failed += 1

elapsed = time.time() - start_time
print(f"\nCompleted in {elapsed:.1f}s")
print(f"Solved: {len(results)}")
print(f"Failed: {failed}")

# Save results
output = {
    'description': 'Water properties on adaptive (u, v) grid',
    'n_points': len(results),
    'generation_method': 'Newton iteration from target (u, v) points',
    'points': results,
}

output_path = Path(__file__).parent / 'uv_grid_data_v4.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"\nSaved to {output_path}")

# Summary by region
regions = {}
for pt in results:
    r = pt.get('region', 'unknown')
    regions[r] = regions.get(r, 0) + 1

print("\nPoints by region:")
for r, count in sorted(regions.items()):
    print(f"  {r}: {count}")

# Summary by phase
phases = {}
for pt in results:
    p = pt.get('phase', 'unknown')
    phases[p] = phases.get(p, 0) + 1

print("\nPoints by phase:")
for p, count in sorted(phases.items()):
    print(f"  {p}: {count}")
