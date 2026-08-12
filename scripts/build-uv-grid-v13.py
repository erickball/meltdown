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
from scipy.optimize import root, brentq
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


R_WATER_KJ = 0.4615  # kJ/(kg*K); with v in m3/kg gives P in kPa


def solve_vapor_uv(u_target, v_target):
    """Inverse (u, v) -> (T, P) for superheated vapour, as two nested 1-D
    monotone root finds instead of one 2-D solve.

    The generic 2-D 'hybr' solve is badly conditioned out here: T ~ 700 and
    P ~ 0.002 MPa differ by five orders of magnitude, and its first trust-region
    step routinely drives P negative, where the objective returns a 1e10 wall
    and the search stalls. That is what left ~50% of the dilute vapour targets
    unsolved (v > 5 m3/kg), and a half-empty grid is what forced the runtime
    interpolator onto its degenerate fallbacks.

    Both directions here are monotone, so brentq cannot fail to converge:
      inner: v(T, P) strictly decreases in P  -> P such that v = v_target
      outer: u(T, P(T)) strictly increases in T -> T such that u = u_target
    """
    def P_for_T(T):
        # Ideal gas is within ~0.1% out here, so it brackets tightly
        P0 = R_WATER_KJ * T / v_target / 1000.0  # MPa
        lo, hi = P0 * 0.5, P0 * 2.0
        try:
            f_lo = IAPWS97(T=T, P=lo).v - v_target
            f_hi = IAPWS97(T=T, P=hi).v - v_target
        except Exception:
            return None
        tries = 0
        while f_lo * f_hi > 0 and tries < 12:
            lo *= 0.5
            hi *= 2.0
            if lo < 1e-9 or hi > 100:
                return None
            try:
                f_lo = IAPWS97(T=T, P=lo).v - v_target
                f_hi = IAPWS97(T=T, P=hi).v - v_target
            except Exception:
                return None
            tries += 1
        if f_lo * f_hi > 0:
            return None
        try:
            return brentq(lambda P: IAPWS97(T=T, P=P).v - v_target,
                          lo, hi, xtol=1e-14, rtol=8.9e-16, maxiter=200)
        except Exception:
            return None

    def u_err(T):
        P = P_for_T(T)
        if P is None:
            return None
        try:
            return IAPWS97(T=T, P=P).u - u_target
        except Exception:
            return None

    # Bracket T. Seed from the ideal-gas caloric inversion and expand.
    T_seed = min(max(273.16 + (u_target - 2375.0) / 1.5, 280.0), 1080.0)
    T_lo = T_hi = None
    f_lo = f_hi = None
    for dT in [0, 25, 50, 100, 200, 400, 800]:
        for T in ({T_seed - dT, T_seed + dT} if dT else {T_seed}):
            if not (273.17 <= T <= 1095):
                continue
            e = u_err(T)
            if e is None:
                continue
            if e < 0 and (T_lo is None or T > T_lo):
                T_lo, f_lo = T, e
            if e > 0 and (T_hi is None or T < T_hi):
                T_hi, f_hi = T, e
        if T_lo is not None and T_hi is not None and T_lo < T_hi:
            break
    if T_lo is None or T_hi is None or T_lo >= T_hi:
        return None

    try:
        T = brentq(lambda t: (u_err(t) if u_err(t) is not None else 1e10),
                   T_lo, T_hi, xtol=1e-10, rtol=8.9e-16, maxiter=200)
    except Exception:
        return None

    P = P_for_T(T)
    if P is None:
        return None
    try:
        w = IAPWS97(T=T, P=P)
    except Exception:
        return None
    if w.u is None or w.v is None:
        return None
    if abs(w.u - u_target) < 0.1 and abs(w.v - v_target) / v_target < 1e-5:
        return {'T_K': float(T), 'T_C': float(T - 273.15), 'P_MPa': float(P)}
    return None


def find_TP_from_uv(u_target, v_target, region, max_attempts=11):
    if region == 'vapor':
        got = solve_vapor_uv(u_target, v_target)
        if got is not None:
            return got

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
        # Ideal-gas seed. Superheated steam at these volumes is very nearly
        # ideal (Z within ~0.1% below a bar), so P = R*T/v and a caloric
        # inversion for T give a guess that is already almost the answer.
        # Without it the fixed P guesses (0.1 - 1 MPa) are 5-50x too high at
        # v > 10 m3/kg and 'hybr' walks off; that is what left a sparse patch
        # in the grid around v ~ 15-30 m3/kg, u ~ 2.9-3.15 MJ/kg, where the
        # runtime interpolator then had too few points to fit and returned a
        # locally CONSTANT surface.
        R_WATER = 0.4615  # kJ/(kg*K) -> gives P in MPa with v in m3/kg
        T_ideal = 273.16 + (u_target - 2375.0) / 1.5   # u in kJ/kg, cv ~1.5 kJ/kg-K
        T_ideal = min(max(T_ideal, 280.0), 1090.0)
        P_ideal = R_WATER * T_ideal / v_target
        guesses += [
            (T_ideal, P_ideal),
            (T_ideal, P_ideal * 1.05),
            (T_init, P_ideal),
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

# v runs out to 210 m3/kg: the saturated-vapour line itself reaches
# v_g = 206 m3/kg at the triple point, so stopping the grid at 100 left the
# most dilute half-decade of the vapour region with no data at all, and the
# runtime had to seam from grid to ideal gas in the middle of it (that seam
# was a ~12% jump in P and ~18 K in T around v ~ 200).
for v in np.logspace(np.log10(v_crit), np.log10(210), 56):
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
