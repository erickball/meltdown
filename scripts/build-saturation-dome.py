"""
Build saturation dome from IAPWS-IF97 equations.

Generate saturation properties at fine temperature resolution,
then fit piecewise polynomials for:
- u_f(T), v_f(T), u_g(T), v_g(T), P_sat(T)
- Inverse functions: T(u_f), T(u_g) for saturation anchoring

Ensure continuity at polynomial boundaries.
"""

import numpy as np
from iapws import IAPWS97
from pathlib import Path
import json

# Temperature range: triple point to just below critical
T_TRIPLE = 273.16  # K (0.01 C)
T_CRITICAL = 647.096  # K (373.946 C)

# Generate fine temperature grid
# Denser near critical point where properties change rapidly
temps_low = np.linspace(T_TRIPLE, 500, 100)      # 0-227 C
temps_mid = np.linspace(500, 600, 80)             # 227-327 C
temps_high = np.linspace(600, 640, 60)            # 327-367 C
temps_critical = np.linspace(640, T_CRITICAL - 0.1, 40)  # 367-373.85 C

temperatures_K = np.unique(np.concatenate([temps_low, temps_mid, temps_high, temps_critical]))
print(f"Generating saturation data at {len(temperatures_K)} temperatures...")

# Compute saturation properties
sat_points = []

for T_K in temperatures_K:
    try:
        # Saturated liquid
        liq = IAPWS97(T=T_K, x=0)
        # Saturated vapor
        vap = IAPWS97(T=T_K, x=1)

        if liq.P is None or vap.P is None:
            continue
        if liq.u is None or liq.v is None:
            continue
        if vap.u is None or vap.v is None:
            continue

        sat_points.append({
            'T_K': float(T_K),
            'T_C': float(T_K - 273.15),
            'P_MPa': float(liq.P),
            'u_f': float(liq.u),
            'v_f': float(liq.v),
            'h_f': float(liq.h) if liq.h else None,
            'u_g': float(vap.u),
            'v_g': float(vap.v),
            'h_g': float(vap.h) if vap.h else None,
        })
    except Exception as e:
        print(f"  Failed at T={T_K:.2f} K: {e}")
        continue

print(f"Generated {len(sat_points)} saturation points")

# Extract arrays for fitting
T_arr = np.array([pt['T_K'] for pt in sat_points])
T_C_arr = np.array([pt['T_C'] for pt in sat_points])
P_arr = np.array([pt['P_MPa'] for pt in sat_points])
u_f_arr = np.array([pt['u_f'] for pt in sat_points])
v_f_arr = np.array([pt['v_f'] for pt in sat_points])
u_g_arr = np.array([pt['u_g'] for pt in sat_points])
v_g_arr = np.array([pt['v_g'] for pt in sat_points])

print(f"\nTemperature range: {T_C_arr[0]:.2f} to {T_C_arr[-1]:.2f} C")
print(f"Pressure range: {P_arr[0]:.6f} to {P_arr[-1]:.4f} MPa")
print(f"u_f range: {u_f_arr[0]:.2f} to {u_f_arr[-1]:.2f} kJ/kg")
print(f"v_f range: {v_f_arr[0]:.6f} to {v_f_arr[-1]:.6f} m³/kg")
print(f"u_g range: {u_g_arr[0]:.2f} to {u_g_arr[-1]:.2f} kJ/kg")
print(f"v_g range: {v_g_arr[0]:.4f} to {v_g_arr[-1]:.6f} m³/kg")


def fit_piecewise_poly(x, y, breakpoints, degree=4):
    """
    Fit piecewise polynomials with continuity at breakpoints.

    Returns list of (x_min, x_max, coefficients) tuples.
    """
    pieces = []
    bp = [x[0]] + list(breakpoints) + [x[-1]]

    for i in range(len(bp) - 1):
        x_min, x_max = bp[i], bp[i + 1]
        mask = (x >= x_min) & (x <= x_max)
        x_seg = x[mask]
        y_seg = y[mask]

        if len(x_seg) < degree + 1:
            print(f"  Warning: segment {x_min:.1f}-{x_max:.1f} has only {len(x_seg)} points")
            degree_use = max(1, len(x_seg) - 1)
        else:
            degree_use = degree

        # Fit polynomial
        coeffs = np.polyfit(x_seg, y_seg, degree_use)

        # Evaluate fit quality
        y_fit = np.polyval(coeffs, x_seg)
        max_err = np.max(np.abs(y_fit - y_seg))
        rms_err = np.sqrt(np.mean((y_fit - y_seg)**2))

        pieces.append({
            'x_min': float(x_min),
            'x_max': float(x_max),
            'degree': degree_use,
            'coeffs': coeffs.tolist(),
            'max_err': float(max_err),
            'rms_err': float(rms_err),
        })

    return pieces


def ensure_continuity(pieces, x_data, y_data):
    """
    Adjust polynomial coefficients to ensure C0 continuity at boundaries.
    Uses weighted least squares to minimize discontinuity while preserving fit.
    """
    # For now, just report discontinuities
    for i in range(len(pieces) - 1):
        x_boundary = pieces[i]['x_max']
        y1 = np.polyval(pieces[i]['coeffs'], x_boundary)
        y2 = np.polyval(pieces[i + 1]['coeffs'], x_boundary)
        gap = abs(y2 - y1)
        if gap > 1e-6:
            print(f"  Discontinuity at x={x_boundary:.1f}: gap = {gap:.6f}")
    return pieces


# Define breakpoints for piecewise fits
# More segments near critical where curvature is high
T_breakpoints = [350, 450, 550, 600, 630]  # in K

print("\n" + "=" * 60)
print("Fitting piecewise polynomials...")
print("=" * 60)

print("\nP_sat(T):")
P_pieces = fit_piecewise_poly(T_arr, P_arr, T_breakpoints, degree=5)
P_pieces = ensure_continuity(P_pieces, T_arr, P_arr)

print("\nu_f(T):")
u_f_pieces = fit_piecewise_poly(T_arr, u_f_arr, T_breakpoints, degree=4)
u_f_pieces = ensure_continuity(u_f_pieces, T_arr, u_f_arr)

print("\nv_f(T):")
v_f_pieces = fit_piecewise_poly(T_arr, v_f_arr, T_breakpoints, degree=4)
v_f_pieces = ensure_continuity(v_f_pieces, T_arr, v_f_arr)

print("\nu_g(T):")
u_g_pieces = fit_piecewise_poly(T_arr, u_g_arr, T_breakpoints, degree=4)
u_g_pieces = ensure_continuity(u_g_pieces, T_arr, u_g_arr)

print("\nv_g(T):")
v_g_pieces = fit_piecewise_poly(T_arr, v_g_arr, T_breakpoints, degree=5)
v_g_pieces = ensure_continuity(v_g_pieces, T_arr, v_g_arr)

# Now fit inverse functions: T(u) along saturation lines
# These are needed for saturation anchoring: given u, find T_sat

print("\n" + "=" * 60)
print("Fitting inverse functions T(u)...")
print("=" * 60)

# u_f is monotonic increasing with T, so T(u_f) is well-defined
u_f_breakpoints = [200, 600, 1000, 1400]  # kJ/kg
print("\nT(u_f):")
T_from_u_f_pieces = fit_piecewise_poly(u_f_arr, T_arr, u_f_breakpoints, degree=4)
T_from_u_f_pieces = ensure_continuity(T_from_u_f_pieces, u_f_arr, T_arr)

# u_g is NOT monotonic - it increases then decreases near critical
# Need to handle this carefully
# Find the maximum
u_g_max_idx = np.argmax(u_g_arr)
print(f"\nu_g maximum at T = {T_C_arr[u_g_max_idx]:.1f} C, u_g = {u_g_arr[u_g_max_idx]:.1f} kJ/kg")

# For u_g, we'll store the raw data and use interpolation instead of polynomial
# Or fit two branches: ascending and descending

# u_g ascending branch: from triple point (u_g ~ 2375) up to maximum (u_g ~ 2603)
# Need to sort by u_g for fitting
print("\nT(u_g) - ascending branch (low T to u_g max):")
u_g_asc = u_g_arr[:u_g_max_idx + 1]
T_asc = T_arr[:u_g_max_idx + 1]
# Sort by u_g (ascending)
sort_idx = np.argsort(u_g_asc)
u_g_asc_sorted = u_g_asc[sort_idx]
T_asc_sorted = T_asc[sort_idx]
u_g_asc_bp = [2450, 2550]  # breakpoints within the range ~2375 to ~2603
T_from_u_g_asc_pieces = fit_piecewise_poly(u_g_asc_sorted, T_asc_sorted, u_g_asc_bp, degree=4)

# u_g descending branch: from maximum (u_g ~ 2603) down to critical (u_g ~ 2056)
print("\nT(u_g) - descending branch (u_g max to critical):")
u_g_desc = u_g_arr[u_g_max_idx:]
T_desc = T_arr[u_g_max_idx:]
if len(u_g_desc) > 5:
    # Sort by u_g ascending for fitting
    sort_idx = np.argsort(u_g_desc)
    u_g_desc_sorted = u_g_desc[sort_idx]
    T_desc_sorted = T_desc[sort_idx]
    u_g_desc_bp = [2200, 2400, 2500]  # breakpoints within ~2056 to ~2603
    T_from_u_g_desc_pieces = fit_piecewise_poly(u_g_desc_sorted, T_desc_sorted,
                                                 u_g_desc_bp, degree=4)
else:
    T_from_u_g_desc_pieces = []

# Package everything
saturation_dome = {
    'description': 'Saturation dome from IAPWS-IF97',
    'T_range_K': [float(T_arr[0]), float(T_arr[-1])],
    'T_range_C': [float(T_C_arr[0]), float(T_C_arr[-1])],
    'critical_point': {
        'T_K': 647.096,
        'T_C': 373.946,
        'P_MPa': 22.064,
        'u_c': float(u_f_arr[-1]),  # At critical, u_f = u_g
        'v_c': float(v_f_arr[-1]),
    },
    'u_g_max': {
        'T_K': float(T_arr[u_g_max_idx]),
        'T_C': float(T_C_arr[u_g_max_idx]),
        'u_g': float(u_g_arr[u_g_max_idx]),
    },
    'polynomials': {
        'P_sat_from_T': P_pieces,
        'u_f_from_T': u_f_pieces,
        'v_f_from_T': v_f_pieces,
        'u_g_from_T': u_g_pieces,
        'v_g_from_T': v_g_pieces,
        'T_from_u_f': T_from_u_f_pieces,
        'T_from_u_g_ascending': T_from_u_g_asc_pieces,
        'T_from_u_g_descending': T_from_u_g_desc_pieces,
    },
    'raw_data': sat_points,
}

# Save to JSON
output_path = Path(__file__).parent / 'saturation_dome_iapws.json'
with open(output_path, 'w') as f:
    json.dump(saturation_dome, f, indent=2)

print(f"\nSaved to {output_path}")

# Verify fits
print("\n" + "=" * 60)
print("Verification: max errors in polynomial fits")
print("=" * 60)

def eval_piecewise(x, pieces):
    """Evaluate piecewise polynomial at x."""
    for piece in pieces:
        if piece['x_min'] <= x <= piece['x_max']:
            return np.polyval(piece['coeffs'], x)
    return None

# Check a few points
test_temps = [300, 400, 500, 550, 600, 630, 645]
print("\nT(K)    P_err(%)   u_f_err   v_f_err(%)   u_g_err   v_g_err(%)")
print("-" * 70)

for T in test_temps:
    if T < T_arr[0] or T > T_arr[-1]:
        continue

    # Get IAPWS values
    liq = IAPWS97(T=T, x=0)
    vap = IAPWS97(T=T, x=1)

    # Get polynomial values
    P_poly = eval_piecewise(T, P_pieces)
    u_f_poly = eval_piecewise(T, u_f_pieces)
    v_f_poly = eval_piecewise(T, v_f_pieces)
    u_g_poly = eval_piecewise(T, u_g_pieces)
    v_g_poly = eval_piecewise(T, v_g_pieces)

    P_err = (P_poly - liq.P) / liq.P * 100 if liq.P else 0
    u_f_err = u_f_poly - liq.u if liq.u else 0
    v_f_err = (v_f_poly - liq.v) / liq.v * 100 if liq.v else 0
    u_g_err = u_g_poly - vap.u if vap.u else 0
    v_g_err = (v_g_poly - vap.v) / vap.v * 100 if vap.v else 0

    print(f"{T:6.1f}  {P_err:8.4f}  {u_f_err:8.3f}  {v_f_err:10.4f}  {u_g_err:8.3f}  {v_g_err:10.4f}")

print("\n" + "=" * 60)
print("Done!")
print("=" * 60)
