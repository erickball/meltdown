"""
Build a (u, v) grid for water property lookups.

For each point on a regular (u, v) grid, solve for (T, P) using IAPWS-IF97.
Export valid points to a file for use in the simulation.

This is a one-time precomputation step.
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
import time

# Define the (u, v) grid bounds
# u: internal energy (kJ/kg) - ranges from ~0 (ice) to ~3000+ (superheated steam)
# v: specific volume (m³/kg) - ranges from ~0.001 (liquid) to ~100+ (low-P steam)

# We'll use a log scale for v since it spans many orders of magnitude
# and a linear scale for u

U_MIN = 0        # kJ/kg (near triple point liquid)
U_MAX = 3200     # kJ/kg (superheated steam)
V_MIN = 0.0009   # m³/kg (highly compressed liquid)
V_MAX = 50.0     # m³/kg (low pressure steam)

# Grid resolution
N_U = 200  # points in u direction
N_V = 200  # points in v direction

# Create grid
u_values = np.linspace(U_MIN, U_MAX, N_U)
v_values = np.logspace(np.log10(V_MIN), np.log10(V_MAX), N_V)

print(f"Building {N_U} x {N_V} = {N_U * N_V} point grid...")
print(f"u range: {U_MIN} to {U_MAX} kJ/kg")
print(f"v range: {V_MIN} to {V_MAX} m³/kg (log scale)")

# For each (u, v) point, we need to find T and P
# This is an inverse problem - IAPWS gives properties FROM (T, P) or (T, x) etc.
# We need to search for T, P such that IAPWS97(T=T, P=P) gives u and v

def find_TP_from_uv(u_target, v_target, tol=1e-6, max_iter=50):
    """
    Find (T, P) that gives the target (u, v) using Newton-Raphson iteration.

    Returns (T_K, P_MPa, phase) or None if no valid solution found.
    """
    # Initial guess based on rough estimates
    # For liquid: T ~ 300-600 K, P ~ 0.1-100 MPa
    # For vapor: T ~ 400-800 K, P ~ 0.001-10 MPa

    # Use v to guess phase
    if v_target < 0.005:  # Likely liquid
        T_guess = 400  # K
        P_guess = 10   # MPa
    elif v_target > 0.1:  # Likely vapor or superheated
        T_guess = 500  # K
        P_guess = 0.1  # MPa
    else:  # Could be either or two-phase
        T_guess = 450
        P_guess = 1.0

    T = T_guess
    P = P_guess

    for iteration in range(max_iter):
        try:
            water = IAPWS97(T=T, P=P)
            if water.u is None or water.v is None:
                return None

            u_calc = water.u  # kJ/kg
            v_calc = water.v  # m³/kg

            # Check convergence
            u_err = (u_calc - u_target) / max(abs(u_target), 1)
            v_err = (v_calc - v_target) / v_target

            if abs(u_err) < tol and abs(v_err) < tol:
                # Determine phase
                if hasattr(water, 'x') and water.x is not None:
                    if water.x < 0.001:
                        phase = 'liquid'
                    elif water.x > 0.999:
                        phase = 'vapor'
                    else:
                        phase = 'two-phase'
                else:
                    # Check if supercritical
                    if T > 647.096 and P > 22.064:
                        phase = 'supercritical'
                    elif v_calc < 0.003:
                        phase = 'liquid'
                    else:
                        phase = 'vapor'

                return (T, P, phase)

            # Newton-Raphson update
            # We need partial derivatives du/dT, du/dP, dv/dT, dv/dP
            # Approximate numerically
            dT = 0.1  # K
            dP = 0.001 * P  # 0.1% of P

            # Partial derivatives
            try:
                water_dT = IAPWS97(T=T+dT, P=P)
                water_dP = IAPWS97(T=T, P=P+dP)

                if water_dT.u is None or water_dP.u is None:
                    return None

                du_dT = (water_dT.u - u_calc) / dT
                du_dP = (water_dP.u - u_calc) / dP
                dv_dT = (water_dT.v - v_calc) / dT
                dv_dP = (water_dP.v - v_calc) / dP

            except:
                return None

            # Solve 2x2 system: J * [dT, dP]^T = -[u_err, v_err]^T
            # J = [[du_dT, du_dP], [dv_dT, dv_dP]]
            det = du_dT * dv_dP - du_dP * dv_dT
            if abs(det) < 1e-20:
                return None

            # Errors in absolute terms
            f_u = u_calc - u_target
            f_v = v_calc - v_target

            delta_T = -(dv_dP * f_u - du_dP * f_v) / det
            delta_P = -(-dv_dT * f_u + du_dT * f_v) / det

            # Damping for stability
            max_dT = 50  # K
            max_dP = P * 0.5  # 50% change max

            delta_T = np.clip(delta_T, -max_dT, max_dT)
            delta_P = np.clip(delta_P, -max_dP, max_dP)

            T_new = T + delta_T
            P_new = P + delta_P

            # Enforce bounds
            T_new = np.clip(T_new, 273.16, 1073.15)  # 0°C to 800°C
            P_new = np.clip(P_new, 0.0001, 100)  # 0.1 kPa to 100 MPa

            T = T_new
            P = P_new

        except Exception as e:
            return None

    return None  # Did not converge


def find_TP_grid_search(u_target, v_target):
    """
    Fallback: grid search to find approximate (T, P).
    """
    best_error = float('inf')
    best_TP = None

    # Coarse grid
    T_range = np.linspace(280, 800, 30)
    P_range = np.logspace(-3, 2, 30)  # 0.001 to 100 MPa

    for T in T_range:
        for P in P_range:
            try:
                water = IAPWS97(T=T, P=P)
                if water.u is None or water.v is None:
                    continue

                u_err = abs(water.u - u_target) / max(abs(u_target), 1)
                v_err = abs(water.v - v_target) / v_target
                error = u_err + v_err

                if error < best_error:
                    best_error = error
                    best_TP = (T, P)

            except:
                continue

    if best_TP and best_error < 0.1:
        return best_TP
    return None


# Build the grid
results = []
valid_count = 0
invalid_count = 0

start_time = time.time()

for i, u in enumerate(u_values):
    if i % 20 == 0:
        elapsed = time.time() - start_time
        print(f"Processing u={u:.0f} kJ/kg ({i+1}/{N_U}, {elapsed:.1f}s elapsed)...")

    for j, v in enumerate(v_values):
        # Try Newton-Raphson first
        result = find_TP_from_uv(u, v)

        if result is None:
            # Try with different initial guesses
            for T_init, P_init in [(350, 5), (500, 0.5), (600, 20), (300, 50)]:
                result = find_TP_from_uv(u, v)
                if result:
                    break

        if result:
            T, P, phase = result
            valid_count += 1
            results.append({
                'u': float(u),
                'v': float(v),
                'T_K': float(T),
                'T_C': float(T - 273.15),
                'P_MPa': float(P),
                'phase': phase,
                'i': i,
                'j': j
            })
        else:
            invalid_count += 1

elapsed = time.time() - start_time
print(f"\nCompleted in {elapsed:.1f} seconds")
print(f"Valid points: {valid_count}")
print(f"Invalid points: {invalid_count}")
print(f"Coverage: {valid_count / (N_U * N_V) * 100:.1f}%")

# Save to JSON
output_path = Path(__file__).parent / 'uv_grid_data.json'
with open(output_path, 'w') as f:
    json.dump({
        'u_values': u_values.tolist(),
        'v_values': v_values.tolist(),
        'n_u': N_U,
        'n_v': N_V,
        'points': results
    }, f)

print(f"\nSaved to {output_path}")

# Also save as compact binary format for faster loading
# (grid indices + T, P values)
grid_data = np.full((N_U, N_V, 2), np.nan)  # T, P at each (i, j)
for pt in results:
    i, j = pt['i'], pt['j']
    grid_data[i, j, 0] = pt['T_K']
    grid_data[i, j, 1] = pt['P_MPa']

np_path = Path(__file__).parent / 'uv_grid_data.npz'
np.savez_compressed(np_path,
                    u_values=u_values,
                    v_values=v_values,
                    grid_data=grid_data)
print(f"Saved binary format to {np_path}")

# Summary statistics
print("\n" + "=" * 60)
print("Grid Statistics")
print("=" * 60)

phases = {}
for pt in results:
    phase = pt['phase']
    phases[phase] = phases.get(phase, 0) + 1

print("\nPoints by phase:")
for phase, count in sorted(phases.items()):
    print(f"  {phase}: {count}")

# Temperature and pressure ranges
if results:
    T_min = min(pt['T_C'] for pt in results)
    T_max = max(pt['T_C'] for pt in results)
    P_min = min(pt['P_MPa'] for pt in results)
    P_max = max(pt['P_MPa'] for pt in results)

    print(f"\nTemperature range: {T_min:.1f} to {T_max:.1f} °C")
    print(f"Pressure range: {P_min:.4f} to {P_max:.2f} MPa")
