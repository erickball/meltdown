"""
Dilute-side patch for the v13 (u, v) grid: the rows build-uv-grid-v13.py
could not solve in its three most dilute vapor columns.

WHY THEY ARE MISSING. Not the filter (filter-uv-grid-v13.py only drops
P > 50 MPa): the rows are absent from uv_grid_data_v13.json itself. v13's
nested solver (solve_vapor_uv) brackets the pressure at 0.5x .. 2x the
ideal-gas estimate, and the `iapws` package refuses any pressure below IF97's
lower limit, 611.2 Pa. So wherever HALF the pressure of a target is under
611.2 Pa - T < 2 * 611.2 * v / R, i.e. below 556 K in the v = 210 m3/kg
column, 454 K at v = 171, 370 K at v = 140, 302 K at v = 114 - the
bracket's low end throws, the monotone solve reports "no state" for every
trial temperature, and the target falls through to v13's generic 2-D solve,
which the same script documents as unreliable out here. That one solved most
of them and missed 16 (the script prints them): interior rows at v = 210
and 171, and the coldest rows - the ones just above the dome - at v = 210
and 140.

WHAT IT COSTS. The runtime fits a local plane to the grid points near a
query. Across a 60-80 kJ/kg hole in the LAST column the fit leans on the
column inside it, and P comes out rippled: read at v = 209.9, Z = P v / R T
wanders 0.9976 .. 1.0029 between u = 2380 and 2700 kJ/kg, where the truth is
0.9998 .. 1.0000. That ripple is what is left of the seam against the dilute
ideal-gas path (which reads this same column), 0.34% in P.

WHAT. Every vapor column is checked against its own v13 ladder - rows 20
kJ/kg apart from u_g(v) + 20 (u_g of the triple point for v beyond the
saturated-vapour line, as v13 has it) up to the old u = 3300 top - and every
absent row whose pressure is under twice the IF97 floor - the rows this
failure can have cost - is solved with the same nested monotone root finds,
the pressure bracket held inside IF97's range. Nothing is special-cased by
column. (One row at v = 114 and the dense near-critical columns also start
above u_g + 20, at pressures this failure cannot reach; those are a
different matter, and are counted and left alone.)

COMPATIBILITY. Same source (IAPWS-IF97 through `iapws`), existing points
carried through byte-identical. Before writing, the script re-solves the
existing rows either side of every hole and refuses to proceed unless they
reproduce to 0.02 K / 0.02%.

Usage: python scripts/build-uv-grid-v13-dilute-patch.py
Writes public/uv_grid_data_v13_filtered.json and the scripts/ copy in place
(git holds the old). A second run finds nothing absent and refuses.
"""

import json
from pathlib import Path

from iapws import IAPWS97
from scipy.optimize import brentq

HERE = Path(__file__).parent
GRID_PATH = HERE.parent / 'public' / 'uv_grid_data_v13_filtered.json'
DOME_PATH = HERE / 'saturation_dome_iapws.json'

R_WATER = 0.461526e-3    # MPa m3/(kg K)
P_FLOOR = 6.1125e-4      # MPa, just above IF97's lower limit (611.213 Pa)
P_MAX = 50.0             # MPa, the grid's cap
U_OLD_TOP = 3300.0       # kJ/kg, the v13 vapor-column top (rows above are the hot patch's)
U_STEP = 20.0            # kJ/kg, the v13 vapor row spacing


def P_for_T(T, v_target):
    """P such that v(T, P) = v_target (v strictly decreases in P at fixed T),
    or None if that density needs a pressure outside IF97's range."""
    P0 = R_WATER * T / v_target
    lo, hi = max(P_FLOOR, 0.5 * P0), min(P_MAX, 2.0 * P0)
    if not lo < hi:
        return None
    try:
        f_lo = IAPWS97(T=T, P=lo).v - v_target
        f_hi = IAPWS97(T=T, P=hi).v - v_target
    except NotImplementedError:   # outside IF97 at this (T, P)
        return None
    if f_lo * f_hi > 0:
        return None
    return brentq(lambda P: IAPWS97(T=T, P=P).v - v_target,
                  lo, hi, xtol=1e-14, rtol=8.9e-16, maxiter=300)


def u_at(T, v_target):
    P = P_for_T(T, v_target)
    if P is None:
        return None
    return IAPWS97(T=T, P=P).u


def solve_point(u_target, v_target, T_lo, T_hi):
    """(u, v) -> (T, P), bracketed in T (u rises with T at fixed v)."""
    u_lo, u_hi = u_at(T_lo, v_target), u_at(T_hi, v_target)
    if u_lo is None or u_hi is None or not (u_lo <= u_target <= u_hi):
        return None
    T = brentq(lambda t: u_at(t, v_target) - u_target, T_lo, T_hi,
               xtol=1e-10, rtol=8.9e-16, maxiter=300)
    P = P_for_T(T, v_target)
    w = IAPWS97(T=T, P=P)
    if abs(w.u - u_target) > 1e-6 or abs(w.v - v_target) / v_target > 1e-9:
        return None
    return {'T_K': float(T), 'T_C': float(T - 273.15), 'P_MPa': float(P)}


def main():
    data = json.loads(GRID_PATH.read_text())
    points = data['points']
    dome = json.loads(DOME_PATH.read_text())['raw_data']
    vg = sorted((r['v_g'], r['u_g']) for r in dome)
    vT = sorted((r['v_g'], r['T_K']) for r in dome)

    def T_sat_from_v(v):
        """Temperature at which saturated vapour has this v (the coldest a
        vapour of this density can be); the triple point for v beyond it."""
        if v >= vT[-1][0]:
            return vT[-1][1]
        for (va, Ta), (vb, Tb) in zip(vT, vT[1:]):
            if va <= v <= vb:
                return Ta + (Tb - Ta) * (v - va) / (vb - va)
        return vT[0][1]

    def u_g_from_v(v):
        """u_g on the saturated-vapour line at this v; the end values outside
        it (v13's interp1d fill) - so the triple point's u_g for v > 206."""
        if v <= vg[0][0]:
            return vg[0][1]
        if v >= vg[-1][0]:
            return vg[-1][1]
        for (va, ua), (vb, ub) in zip(vg, vg[1:]):
            if va <= v <= vb:
                return ua + (ub - ua) * (v - va) / (vb - va)

    by_v = {}
    for p in points:
        if p['region'] == 'vapor':
            by_v.setdefault(p['v'], []).append(p)

    holes = []   # (v, u, existing row below or None, existing row above)
    for v, col in sorted(by_v.items()):
        col.sort(key=lambda p: p['u'])
        # Only v13's own full-height columns: the patches' fringe and
        # near-critical columns have their own ladders.
        low = [p for p in col if p['u'] < U_OLD_TOP]
        if len(low) < 2 or col[-1]['P_MPa'] > P_MAX:
            continue
        # Rows v13 targeted below the first one it solved
        u_floor = u_g_from_v(v) + U_STEP
        u = low[0]['u'] - U_STEP
        below = []
        while u > u_floor - 1e-6:
            below.append(u)
            u -= U_STEP
        for u in sorted(below):
            holes.append((v, u, None, low[0]))
        # Rows absent between two it solved
        for a, b in zip(low, low[1:]):
            n = round((b['u'] - a['u']) / U_STEP)
            for k in range(1, n):
                holes.append((v, a['u'] + k * U_STEP, a, b))

    cols = sorted({v for v, *_ in holes})
    print(f"{len(holes)} absent rows in {len(cols)} column(s): " +
          ", ".join(f"v={v:.4g}" for v in cols))

    # Self-check: the existing rows either side of every hole must reproduce.
    worst_T = worst_P = 0.0
    for p in {id(q): q for _, _, a, b in holes for q in (a, b) if q is not None}.values():
        r = solve_point(p['u'], p['v'], p['T_K'] - 5.0, p['T_K'] + 5.0)
        if r is None:
            raise SystemExit(f"REFUSING: cannot re-solve existing point u={p['u']} v={p['v']}")
        worst_T = max(worst_T, abs(r['T_K'] - p['T_K']))
        worst_P = max(worst_P, abs(r['P_MPa'] - p['P_MPa']) / p['P_MPa'])
    print(f"Self-check: worst dT = {worst_T:.6f} K, worst dP = {worst_P * 100:.6f}%")
    if worst_T > 0.02 or worst_P > 2e-4:
        raise SystemExit("REFUSING: patch solver does not reproduce the existing surface")

    added, out_of_scope = [], []
    for v, u, a, b in holes:
        # In scope: rows v13's pressure bracket could have cost (see the
        # docstring). The row above bounds this row's pressure from above.
        if b['P_MPa'] >= 2 * P_FLOOR and (a is None or a['P_MPa'] >= 2 * P_FLOOR):
            out_of_scope.append((v, u))
            continue
        # With no solved row below to bracket from: the coldest vapour IF97
        # holds at this density - on the dome, or on IF97's pressure floor
        # for densities the dome does not reach (0.2% above the ideal-gas
        # estimate of either: Z is 0.9994 there, so the state at exactly
        # that temperature needs a pressure a hair under the floor).
        T_lo = a['T_K'] if a is not None else             max(T_sat_from_v(v), P_FLOOR * v / R_WATER) * 1.002
        r = solve_point(u, v, T_lo, b['T_K'])
        if r is None:
            raise SystemExit(f"REFUSING: no IF97 state at u={u} v={v} "
                             f"(below IF97's pressure floor at this density?)")
        if r['P_MPa'] >= 2 * P_FLOOR:
            out_of_scope.append((v, u))
            continue
        added.append({'u': float(u), 'v': v, **r, 'region': 'vapor'})
        Z = r['P_MPa'] * v / (R_WATER * r['T_K'])
        print(f"  v={v:.4g} u={u:.3f}: T={r['T_K']:.3f} K, P={r['P_MPa'] * 1e6:.2f} Pa, Z={Z:.6f}")

    if out_of_scope:
        vs = sorted({v for v, _ in out_of_scope})
        print(f"Left alone: {len(out_of_scope)} absent rows above twice the IF97 floor, "
              f"in columns v = {vs[0]:.4g} .. {vs[-1]:.4g}")
    if not added:
        raise SystemExit("REFUSING: nothing to add - the grid is already patched")

    merged = points + added
    data['points'] = merged
    data['n_points'] = len(merged)
    data['description'] = (data.get('description', '') +
                           ' + dilute patch (rows v13 could not solve in the v=140..210 '
                           'columns, where its pressure bracket crossed the IF97 floor; same '
                           'IAPWS-IF97 source, self-checked)')
    text = json.dumps(data, indent=2)
    # LF on every platform: .gitattributes pins these files to eol=lf.
    GRID_PATH.write_text(text, newline='\n')
    # The runtime loads TWO copies: public/ in the browser, scripts/ in Node
    # (see loadDataSync in water-properties-v4.ts). Keep them identical.
    (HERE / 'uv_grid_data_v13_filtered.json').write_text(text, newline='\n')
    print(f"Wrote {GRID_PATH} (+ scripts copy) with {len(merged)} points (+{len(added)})")


if __name__ == '__main__':
    main()
