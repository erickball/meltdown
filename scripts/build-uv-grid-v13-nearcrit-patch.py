"""
Near-critical patch for the v13 (u, v) grid.

WHY. The v13 vapor columns between v_crit and v ~ 0.012 m3/kg are truncated
well below their intended u = 3300 top (v = 0.0053 stops at u = 2797,
v = 0.0043 at 2613): solve_vapor_uv brackets pressure around the IDEAL-GAS
estimate x[0.5, 2], and dense near-critical vapor (rho ~ 150-300) sits at
half the ideal-gas pressure, so the bracket missed the root and the targets
silently failed. The supercritical band also stops at u = 2800. The corner
left uncovered - u ~ 2.6-3.3 MJ/kg at rho ~ 100-300 - is ordinary dense
superheated steam around 200-500 bar, and any plant whose boiler visits
190+ bar with superheat lands the runtime interpolator in it and dies.

COMPATIBILITY. Same source as v13: IAPWS-IF97 through the same `iapws`
package, solved with the same nested-brentq structure, only with a WIDE
fixed pressure bracket instead of the ideal-gas-anchored one. Existing
points are carried through byte-identical; before writing anything the
script re-solves a sample of existing near-seam points and refuses to
proceed unless they reproduce to 0.02 K / 0.02%, so the patch provably
joins the surface it extends. The v13 global filter (P <= 50 MPa) applies
to the new points too.

Usage: python scripts/build-uv-grid-v13-nearcrit-patch.py
Writes public/uv_grid_data_v13_filtered.json in place (git holds the old).
"""

import json
import time
from pathlib import Path

import numpy as np
from iapws import IAPWS97
from scipy.optimize import brentq

HERE = Path(__file__).parent
GRID_PATH = HERE.parent / 'public' / 'uv_grid_data_v13_filtered.json'

V_CRIT = 0.003106    # m3/kg
# The v13 grid was globally filtered to P <= 50 MPa, at a different u for
# every v - a STAIRCASE boundary. Interpolation next to a step has no
# support on one side, which is the actual runtime hole (u=2900, v=0.0062
# failed with true P ~ 28 MPa, nowhere near the cap - its left-hand column
# was cut 100 kJ/kg lower). The patch extends the near-critical columns to
# IF97 region 3's own 100 MPa limit so the boundary sits far above any
# state a plant reaches, and adds midpoint columns for two-sided support.
P_MAX_MPA = 100.0
U_TOP = 3300.0       # kJ/kg, the v13 vapor-column top, kept


def solve_dense_uv(u_target, v_target):
    """(u, v) -> (T, P) with a WIDE fixed pressure bracket.

    Same nested monotone structure as v13's solve_vapor_uv: inner brentq on
    P so that v(T, P) = v_target (v strictly decreases in P at fixed T,
    through IF97 regions 2 and 3 alike), outer brentq on T so that u = u_target.
    The only change is the bracket: [7e-4, 100] MPa always, instead of the
    ideal-gas anchor that misses dense states.
    """
    def P_for_T(T):
        # IF97's floor is the triple-point pressure - probing below it
        # throws 'Incoming out of bound' before any sign check can run.
        lo, hi = 7e-4, 100.0
        try:
            f_lo = IAPWS97(T=T, P=lo).v - v_target
            f_hi = IAPWS97(T=T, P=hi).v - v_target
        except Exception:
            return None
        if f_lo is None or f_hi is None or f_lo * f_hi > 0:
            return None
        try:
            return brentq(lambda P: IAPWS97(T=T, P=P).v - v_target,
                          lo, hi, xtol=1e-14, rtol=8.9e-16, maxiter=300)
        except Exception:
            return None

    def u_err(T):
        P = P_for_T(T)
        if P is None:
            return None
        try:
            w = IAPWS97(T=T, P=P)
            if w.u is None:
                return None
            return w.u - u_target
        except Exception:
            return None

    # Bracket T. Dense states sit just above the two-phase gap, where the
    # valid-T window below the root can be only a few kelvin wide - a coarse
    # scan alone never lands in it. So: coarse scan for signs, and when only
    # positives show up, bisect the validity edge (the last None / first
    # valid boundary, which hugs the saturation crossing) and bracket from
    # just above it.
    T_lo = T_hi = None
    T_none_last = None
    T_valid_first = None
    for T in np.arange(300.0, 1090.0, 25.0):
        e = u_err(float(T))
        if e is None:
            if T_valid_first is None:
                T_none_last = float(T)
            continue
        if T_valid_first is None:
            T_valid_first = float(T)
        if e < 0:
            T_lo = float(T)
        elif T_hi is None:
            T_hi = float(T)
            break
    if T_lo is None and T_hi is not None and T_none_last is not None:
        lo_edge, hi_edge = T_none_last, T_hi
        for _ in range(60):
            mid = 0.5 * (lo_edge + hi_edge)
            if u_err(mid) is None:
                lo_edge = mid
            else:
                hi_edge = mid
            if hi_edge - lo_edge < 0.02:
                break
        e_edge = u_err(hi_edge)
        if e_edge is not None and e_edge < 0:
            T_lo = hi_edge
    if T_lo is None or T_hi is None or T_lo >= T_hi:
        return None

    try:
        T = brentq(lambda t: (u_err(t) if u_err(t) is not None else 1e10),
                   T_lo, T_hi, xtol=1e-10, rtol=8.9e-16, maxiter=300)
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


def main():
    data = json.loads(GRID_PATH.read_text())
    points = data['points'] if 'points' in data else data['grid_points']
    print(f"Loaded {len(points)} existing points")

    # ------------------------------------------------------------------
    # Seam self-check: the patch must reproduce the surface it extends.
    # Take the topmost existing points of each truncated vapor column and
    # the top of the supercritical band and re-solve them.
    # ------------------------------------------------------------------
    near = [p for p in points
            if p['region'] in ('vapor', 'supercritical')
            and p['v'] <= 0.015 and p['u'] >= 2400]
    by_v = {}
    for p in near:
        by_v.setdefault(round(p['v'], 6), []).append(p)
    seam_samples = []
    for v, col in sorted(by_v.items()):
        col.sort(key=lambda p: p['u'])
        seam_samples.extend(col[-2:])
    print(f"Seam self-check on {len(seam_samples)} existing points...")
    worst_T = worst_P = 0.0
    for p in seam_samples:
        r = solve_dense_uv(p['u'], p['v'])
        if r is None:
            raise SystemExit(f"REFUSING: cannot re-solve existing point u={p['u']} v={p['v']}")
        dT = abs(r['T_K'] - p['T_K'])
        dP = abs(r['P_MPa'] - p['P_MPa']) / p['P_MPa']
        worst_T = max(worst_T, dT)
        worst_P = max(worst_P, dP)
    print(f"  worst dT = {worst_T:.4f} K, worst dP = {worst_P * 100:.4f}%")
    if worst_T > 0.02 or worst_P > 2e-4:
        raise SystemExit("REFUSING: patch solver does not reproduce the existing surface")

    # ------------------------------------------------------------------
    # Targets: extend each truncated near-critical vapor column to the
    # v13 top (u = 3300, P <= 50 MPa), and the supercritical band from its
    # u = 2800 stop up to the same top.
    # ------------------------------------------------------------------
    existing = {(round(p['u'], 4), round(p['v'], 8)) for p in points}
    targets = []
    for v, col in sorted(by_v.items()):
        if not (V_CRIT <= v <= 0.015):
            continue
        u_max = max(p['u'] for p in col)
        for u in np.arange(u_max + 20.0, U_TOP + 1e-9, 20.0):
            targets.append({'u': float(u), 'v': float(v), 'region': 'vapor'})

    # Midpoint columns between the existing near-critical vapor columns:
    # even with every column at full height, the interpolator wants
    # two-sided support inside the widest gaps.
    col_vs = sorted(v for v in by_v if V_CRIT <= v <= 0.015)
    for va, vb in zip(col_vs, col_vs[1:]):
        vm = float(np.sqrt(va * vb))
        u_lo = min(p['u'] for p in by_v[va] + by_v[vb])
        for u in np.arange(u_lo, U_TOP + 1e-9, 20.0):
            targets.append({'u': float(u), 'v': vm, 'region': 'vapor'})

    # The strip between the supercritical band's surviving top column
    # (~0.0029 - the v_crit column itself failed to generate in v13) and the
    # first vapor column (0.00353) has NO columns at all: a 20%-wide blind
    # slot in v running the full height of the dense region. Plant states
    # walked straight into it. Four explicit columns at ~4.5% spacing.
    for vm in (0.00298, 0.00311, 0.00325, 0.00339):
        region = 'supercritical' if vm < 0.003106 else 'vapor'
        for u in np.arange(2100.0, U_TOP + 1e-9, 20.0):
            targets.append({'u': float(u), 'v': vm, 'region': region})

    sc_vs = sorted({round(p['v'], 8) for p in points if p['region'] == 'supercritical'})
    for v in sc_vs:
        u_max = max(p['u'] for p in points
                    if p['region'] == 'supercritical' and round(p['v'], 8) == v)
        for u in np.arange(u_max + 20.0, U_TOP + 1e-9, 20.0):
            targets.append({'u': float(u), 'v': float(v), 'region': 'supercritical'})

    targets = [t for t in targets
               if (round(t['u'], 4), round(t['v'], 8)) not in existing]
    print(f"{len(targets)} patch targets")

    # ------------------------------------------------------------------
    # Solve
    # ------------------------------------------------------------------
    added, failed, over_p = [], [], 0
    t0 = time.time()
    for i, t in enumerate(targets):
        r = solve_dense_uv(t['u'], t['v'])
        if r is None:
            failed.append(t)
        elif r['P_MPa'] > P_MAX_MPA:
            over_p += 1
        else:
            added.append({'u': t['u'], 'v': t['v'], **r,
                          'region': t['region'], 'curve': None})
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(targets)} ({time.time() - t0:.0f}s), "
                  f"{len(added)} added, {len(failed)} failed, {over_p} over {P_MAX_MPA} MPa")

    print(f"Done: {len(added)} added, {len(failed)} failed, {over_p} filtered by P <= {P_MAX_MPA} MPa")
    if failed:
        for f in failed[:10]:
            print(f"  failed: u={f['u']:.0f} v={f['v']:.6f}")
    if len(added) == 0:
        raise SystemExit("REFUSING: nothing to add")

    # ------------------------------------------------------------------
    # Merge - existing points carried through untouched - and write.
    # ------------------------------------------------------------------
    merged = points + added
    data['points' if 'points' in data else 'grid_points'] = merged
    data['n_points'] = len(merged)
    data['description'] = (data.get('description', '') +
                           ' + near-critical patch (dense vapor/supercritical columns '
                           'extended to u=3300, same IAPWS-IF97 source, seam-checked)')
    text = json.dumps(data, indent=2)
    GRID_PATH.write_text(text)
    # The runtime loads TWO copies: public/ in the browser, scripts/ in Node
    # (see loadDataSync in water-properties-v4.ts). Keep them identical.
    (HERE / 'uv_grid_data_v13_filtered.json').write_text(text)
    print(f"Wrote {GRID_PATH} (+ scripts copy) with {len(merged)} points")


if __name__ == '__main__':
    main()
