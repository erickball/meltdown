"""
Build a (u, v) grid for water property lookups - Version 2.

Key improvements:
- Adaptive spacing: denser in compressed liquid, sparser in vapor
- Skip two-phase region (already handled separately)
- More efficient search strategy
- Focus on regions actually used in simulation

For each point on the (u, v) grid, solve for (T, P) using IAPWS-IF97.
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
import time
from scipy.optimize import fsolve

# Read saturation dome data to know what to skip
sat_data = []
sat_path = Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt'
with open(sat_path, 'r') as f:
    lines = f.readlines()
    for line in lines[1:]:
        parts = line.strip().split('\t')
        if len(parts) >= 6:
            try:
                sat_data.append({
                    'P_MPa': float(parts[0]),
                    'T_C': float(parts[1]),
                    'v_f': float(parts[2]),
                    'v_g': float(parts[3]),
                    'u_f': float(parts[4]),
                    'u_g': float(parts[5]),
                })
            except:
                pass

print(f"Loaded {len(sat_data)} saturation points")

# Build saturation dome boundary in (u, v) space
# Liquid line: (u_f, v_f) from triple point to critical
# Vapor line: (u_g, v_g) from critical back to triple point
dome_liquid = [(pt['u_f'], pt['v_f']) for pt in sat_data]
dome_vapor = [(pt['u_g'], pt['v_g']) for pt in sat_data]

def is_in_two_phase(u, v):
    """Check if (u, v) is inside the saturation dome."""
    # Simple check: is u below the saturation dome at this v?
    # Find bracketing v values on liquid and vapor lines

    # Check liquid side (small v)
    for i in range(len(dome_liquid) - 1):
        v1, v2 = dome_liquid[i][1], dome_liquid[i+1][1]
        if min(v1, v2) <= v <= max(v1, v2):
            # Interpolate u_f at this v
            t = (v - v1) / (v2 - v1) if v2 != v1 else 0
            u_f = dome_liquid[i][0] + t * (dome_liquid[i+1][0] - dome_liquid[i][0])
            if u < u_f:
                return False  # Below liquid line (compressed liquid)

    # Check vapor side (large v)
    for i in range(len(dome_vapor) - 1):
        v1, v2 = dome_vapor[i][1], dome_vapor[i+1][1]
        if min(v1, v2) <= v <= max(v1, v2):
            t = (v - v1) / (v2 - v1) if v2 != v1 else 0
            u_g = dome_vapor[i][0] + t * (dome_vapor[i+1][0] - dome_vapor[i][0])
            if u > u_g:
                return False  # Above vapor line (superheated)

    # Check if v is within dome range
    v_f_min = min(pt['v_f'] for pt in sat_data)
    v_g_max = max(pt['v_g'] for pt in sat_data)

    if v < v_f_min or v > v_g_max:
        return False  # Outside dome v range

    # Inside the dome
    return True


def find_TP_from_uv_scipy(u_target, v_target, T_init=400, P_init=1.0):
    """
    Find (T, P) that gives target (u, v) using scipy's fsolve.
    """
    def residual(x):
        T, P = x
        if T < 273.16 or T > 1073.15 or P < 0.0001 or P > 100:
            return [1e10, 1e10]
        try:
            water = IAPWS97(T=T, P=P)
            if water.u is None or water.v is None:
                return [1e10, 1e10]
            return [
                (water.u - u_target) / max(abs(u_target), 100),
                (water.v - v_target) / v_target
            ]
        except:
            return [1e10, 1e10]

    try:
        solution, info, ier, msg = fsolve(residual, [T_init, P_init], full_output=True)
        if ier == 1:  # Converged
            T, P = solution
            if 273.16 <= T <= 1073.15 and 0.0001 <= P <= 100:
                # Verify solution
                water = IAPWS97(T=T, P=P)
                if water.u is not None and water.v is not None:
                    u_err = abs(water.u - u_target) / max(abs(u_target), 100)
                    v_err = abs(water.v - v_target) / v_target
                    if u_err < 0.001 and v_err < 0.001:
                        return (T, P)
    except:
        pass
    return None


def get_phase(T, P, v):
    """Determine phase from T, P, v."""
    T_crit = 647.096
    P_crit = 22.064

    if T > T_crit and P > P_crit:
        return 'supercritical'

    # Get saturation properties at this T or P
    try:
        sat = IAPWS97(T=T, x=0)
        if sat.P is not None:
            P_sat = sat.P
            v_f = sat.v
            sat_v = IAPWS97(T=T, x=1)
            v_g = sat_v.v if sat_v.v else v_f * 1000

            if P > P_sat * 1.001:
                return 'compressed_liquid'
            elif P < P_sat * 0.999:
                if v > v_g:
                    return 'superheated_vapor'
                else:
                    return 'vapor'  # Near saturation
            else:
                return 'saturated'
    except:
        pass

    # Fallback based on v
    if v < 0.01:
        return 'liquid'
    else:
        return 'vapor'


# Define adaptive grid
# Compressed liquid: fine spacing in both u and v
# Superheated vapor: coarser spacing, especially at high v
# Supercritical: medium spacing

print("\nBuilding adaptive (u, v) grid...")

# Region 1: Compressed liquid
# u: 0 to ~1000 kJ/kg (below saturation)
# v: 0.0009 to 0.003 m³/kg
u_liquid = np.linspace(0, 1200, 80)
v_liquid = np.linspace(0.0009, 0.004, 40)

# Region 2: Near-critical and supercritical
# u: 1000 to 2200 kJ/kg
# v: 0.002 to 0.02 m³/kg
u_critical = np.linspace(1000, 2400, 60)
v_critical = np.logspace(np.log10(0.002), np.log10(0.02), 40)

# Region 3: Superheated vapor
# u: 2000 to 3200 kJ/kg
# v: 0.01 to 50 m³/kg (log scale)
u_vapor = np.linspace(2000, 3200, 50)
v_vapor = np.logspace(np.log10(0.01), np.log10(50), 50)

# Combine into single set of unique (u, v) points
all_uv = set()

for u in u_liquid:
    for v in v_liquid:
        all_uv.add((u, v))

for u in u_critical:
    for v in v_critical:
        all_uv.add((u, v))

for u in u_vapor:
    for v in v_vapor:
        all_uv.add((u, v))

print(f"Total candidate points: {len(all_uv)}")

# Filter out two-phase region
filtered_uv = []
for u, v in all_uv:
    if not is_in_two_phase(u, v):
        filtered_uv.append((u, v))

print(f"After removing two-phase: {len(filtered_uv)}")

# Sort by u then v for consistent processing
filtered_uv.sort()

# Process each point
results = []
valid_count = 0
invalid_count = 0
skipped_count = 0

start_time = time.time()
last_report = start_time

# Initial guesses for different regions
def get_initial_guess(u, v):
    """Get reasonable initial T, P guess based on u, v."""
    if v < 0.002:  # Compressed liquid
        # Higher u = higher T
        T_guess = 300 + u / 5  # Rough estimate
        T_guess = min(max(T_guess, 280), 640)
        P_guess = 15  # High pressure for liquid
        return T_guess, P_guess
    elif v < 0.01:  # Near critical or compressed
        T_guess = 500 + u / 10
        T_guess = min(max(T_guess, 400), 700)
        P_guess = 5
        return T_guess, P_guess
    else:  # Vapor
        # For ideal gas: u ≈ cv*T, v ≈ RT/P
        # Very rough: T ~ u/2 (kJ/kg to K), P ~ RT/v
        T_guess = 300 + u / 4
        T_guess = min(max(T_guess, 350), 900)
        P_guess = 0.461 * T_guess / v / 1000  # R_water ≈ 0.461 kJ/(kg·K)
        P_guess = min(max(P_guess, 0.001), 50)
        return T_guess, P_guess


for idx, (u, v) in enumerate(filtered_uv):
    now = time.time()
    if now - last_report > 5:
        elapsed = now - start_time
        pct = (idx + 1) / len(filtered_uv) * 100
        print(f"  {idx+1}/{len(filtered_uv)} ({pct:.1f}%), {valid_count} valid, {elapsed:.0f}s elapsed")
        last_report = now

    # Get initial guess
    T_init, P_init = get_initial_guess(u, v)

    # Try to find T, P
    result = find_TP_from_uv_scipy(u, v, T_init, P_init)

    # If failed, try other initial guesses
    if result is None:
        for T_try, P_try in [(400, 10), (500, 1), (600, 0.1), (350, 20), (700, 5)]:
            result = find_TP_from_uv_scipy(u, v, T_try, P_try)
            if result:
                break

    if result:
        T, P = result
        phase = get_phase(T, P, v)

        # Verify by computing u, v from T, P
        water = IAPWS97(T=T, P=P)
        u_check = water.u
        v_check = water.v

        valid_count += 1
        results.append({
            'u': float(u),
            'v': float(v),
            'T_K': float(T),
            'T_C': float(T - 273.15),
            'P_MPa': float(P),
            'phase': phase,
            'u_check': float(u_check),
            'v_check': float(v_check),
        })
    else:
        invalid_count += 1

elapsed = time.time() - start_time
print(f"\nCompleted in {elapsed:.1f} seconds")
print(f"Valid points: {valid_count}")
print(f"Invalid points: {invalid_count}")

# Save results
output_path = Path(__file__).parent / 'uv_grid_data_v2.json'
with open(output_path, 'w') as f:
    json.dump({
        'description': 'Water properties on (u, v) grid - adaptive spacing',
        'n_points': len(results),
        'points': results
    }, f, indent=2)

print(f"\nSaved to {output_path}")

# Summary by phase
phases = {}
for pt in results:
    phase = pt['phase']
    phases[phase] = phases.get(phase, 0) + 1

print("\nPoints by phase:")
for phase, count in sorted(phases.items()):
    print(f"  {phase}: {count}")

# Ranges
if results:
    print(f"\nu range: {min(pt['u'] for pt in results):.0f} to {max(pt['u'] for pt in results):.0f} kJ/kg")
    print(f"v range: {min(pt['v'] for pt in results):.6f} to {max(pt['v'] for pt in results):.2f} m³/kg")
    print(f"T range: {min(pt['T_C'] for pt in results):.1f} to {max(pt['T_C'] for pt in results):.1f} °C")
    print(f"P range: {min(pt['P_MPa'] for pt in results):.4f} to {max(pt['P_MPa'] for pt in results):.2f} MPa")
