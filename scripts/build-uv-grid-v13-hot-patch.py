"""
Hot-side patch for the v13 (u, v) grid: superheated steam above u = 3300 kJ/kg.

WHY. The v13 vapor columns stop at u = 3300 kJ/kg, which is only 590-650 C
(the temperature at that energy depends on density, so the table's hot edge
is not one temperature). A gas-cooled plant's steam generator sees 750 C
helium, its isolated tubes sit at 650-750 C and 180 bar after a blackout, and
severe accidents go far hotter - all of it past the table. Past the edge the
runtime continues with an anchored ideal-gas extension (constant
compressibility, ideal-gas cv). That is continuous with the table but drifts
from IF97 as it leaves the edge, most at high pressure where steam is not
ideal: at 180 bar it reads 3 K high / 1.1% low in P at 700 C, 8 K / 2.6% at
800 C, 15 K / 4.4% at 1000 C. And it warns on every use, so a plant that
legitimately lives up there spams the console.

WHAT. Every full-height vapor column (one that reaches the old u ~ 3300 top)
is continued upward on its own 20 kJ/kg rows until it leaves either

    T <= 2273.15 K   IAPWS-IF97's upper temperature limit (region 5), or
    P <= 50 MPa      region 5's pressure limit - and the cap the v13 filter
                     already applies to the whole grid.

So the hot edge becomes the 2273.15 K (2000 C) isotherm for v > ~0.021 m3/kg
and the 50 MPa isobar from there down to v ~ 0.008, where it meets the old
top. The runtime's anchored extension still takes over past that edge - and
still warns, as it should: beyond it there is no table, and above ~2500 K
steam dissociates.

FRINGE COLUMNS. Along the 50 MPa isobar the top of the grid is SLOPED: the
regular columns there end 50-900 kJ/kg apart. The runtime never extrapolates
the vapor grid sideways in v, and it places the hot edge on the chord between
column tops - so between two columns of very different height there is a
sliver under the chord with data on one side only, and a state landing in it
throws (a sealed vessel of 190 bar steam heated to 1700 C walks into one).
The near-critical patch met the same thing at its 100 MPa staircase and
added midpoint columns; this does the equivalent: short columns between the
regular ones, spaced so that neighbouring tops differ by at most
FRINGE_TOP_STEP, each reaching FRINGE_DEPTH below the isobar. Every state
under the edge then has data on both sides. scripts/probe-hot-steam-grid.ts
scans for exactly this.

COMPATIBILITY. Same source as v13 (IAPWS-IF97 through the same `iapws`
package), same nested monotone brentq structure. Existing points are carried
through byte-identical; before writing anything the script re-solves the top
two points of every column it extends and refuses to proceed unless they
reproduce to 0.02 K / 0.02%, so the patch provably joins the surface it
extends. IF97's regions 2 and 5 disagree by up to 0.15 kJ/kg in u (0.07 K)
on their shared 1073.15 K boundary; a target that lands inside that sliver
has no solution, is reported, and is left out (its neighbours 20 kJ/kg
either side carry the fit).

Usage: python scripts/build-uv-grid-v13-hot-patch.py
Writes public/uv_grid_data_v13_filtered.json and the scripts/ copy in place
(git holds the old). Run once: a second run finds the columns already
extended and refuses.
"""

import json
import math
import time
from pathlib import Path

from iapws import IAPWS97
from scipy.optimize import brentq

HERE = Path(__file__).parent
GRID_PATH = HERE.parent / 'public' / 'uv_grid_data_v13_filtered.json'

R_WATER = 0.461526e-3    # MPa m3/(kg K)
T_MAX = 2273.15          # K, IF97 region 5 upper limit
P_MAX = 50.0             # MPa, IF97 region 5 limit = the v13 filter's cap
P_FLOOR = 7e-4           # MPa, just above IF97's triple-point floor
U_OLD_TOP = 3300.0       # kJ/kg, the v13 vapor-column top
U_STEP = 20.0            # kJ/kg, the v13 vapor row spacing, kept
# Fringe columns under the sloped 50 MPa edge (see the docstring). The step
# is two rows: the runtime's fit reaches 100 kJ/kg in u, so neighbours two
# rows apart overlap over most of it. The depth is where the staggered
# fringe hands over to the regular columns' own two-sided coverage.
FRINGE_TOP_STEP = 40.0   # kJ/kg
FRINGE_DEPTH = 400.0     # kJ/kg
T_FRINGE_LOW = 800.0     # K, a temperature below every fringe row (u < 3300 there)


def P_for_T(T, v_target):
    """P such that v(T, P) = v_target, or None if that density lies beyond
    P_MAX at this temperature (v strictly decreases in P at fixed T)."""
    lo, hi = P_FLOOR, P_MAX
    f_lo = IAPWS97(T=T, P=lo).v - v_target
    f_hi = IAPWS97(T=T, P=hi).v - v_target
    if f_lo * f_hi > 0:
        return None
    # Tighten around the ideal-gas estimate when that brackets (hot steam has
    # Z ~ 0.85-1.05); verified by sign, the wide bracket stays the fallback.
    P0 = R_WATER * T / v_target
    a, b = max(lo, 0.6 * P0), min(hi, 1.2 * P0)
    if a < b and (IAPWS97(T=T, P=a).v - v_target) * (IAPWS97(T=T, P=b).v - v_target) < 0:
        lo, hi = a, b
    return brentq(lambda P: IAPWS97(T=T, P=P).v - v_target,
                  lo, hi, xtol=1e-14, rtol=8.9e-16, maxiter=300)


def u_at(T, v_target):
    P = P_for_T(T, v_target)
    if P is None:
        return None
    return IAPWS97(T=T, P=P).u


def hottest_valid_T(T_valid, v_target):
    """The highest T at which this density is still inside the table's
    (T_MAX, P_MAX) limits. T_valid is a temperature known to be inside; the
    pressure needed for a fixed v only rises with T."""
    if u_at(T_MAX, v_target) is not None:
        return T_MAX
    lo, hi = T_valid, T_MAX
    while hi - lo > 1e-6:
        mid = 0.5 * (lo + hi)
        if u_at(mid, v_target) is None:
            hi = mid
        else:
            lo = mid
    return lo


def solve_column_point(u_target, v_target, T_below, T_top):
    """(u, v) -> (T, P) for a target in a column, bracketed in T (u rises
    with T at fixed v). Returns a dict, None when the target is hotter than
    T_top (past the table's limits on this column), or 'no-root' when IF97
    has no state there (the region 2/5 boundary sliver)."""
    if u_at(T_below, v_target) - u_target > 0:
        return 'no-root'
    if u_at(T_top, v_target) - u_target < 0:
        return None
    T = brentq(lambda t: u_at(t, v_target) - u_target, T_below, T_top,
               xtol=1e-10, rtol=8.9e-16, maxiter=300)
    P = P_for_T(T, v_target)
    w = IAPWS97(T=T, P=P)
    if abs(w.u - u_target) < 0.1 and abs(w.v - v_target) / v_target < 1e-5:
        return {'T_K': float(T), 'T_C': float(T - 273.15), 'P_MPa': float(P)}
    return 'no-root'


def main():
    data = json.loads(GRID_PATH.read_text())
    points = data['points']
    print(f"Loaded {len(points)} existing points")

    # Full-height vapor columns: those whose top row is the old u ~ 3300 top.
    by_v = {}
    for p in points:
        if p['region'] == 'vapor':
            by_v.setdefault(p['v'], []).append(p)
    if any(p['u'] > U_OLD_TOP + 1e-9 for col in by_v.values() for p in col):
        raise SystemExit("REFUSING: the grid is already extended past u = 3300")
    columns = []
    for v, col in sorted(by_v.items()):
        col.sort(key=lambda p: p['u'])
        # ... and still inside the pressure cap there (the near-critical
        # patch's columns run to 100 MPa; those are left as they are).
        if col[-1]['u'] > U_OLD_TOP - U_STEP and col[-1]['P_MPa'] <= P_MAX:
            columns.append((v, col))
    print(f"{len(columns)} full-height vapor columns inside {P_MAX:.0f} MPa, "
          f"v = {columns[0][0]:.5f} .. {columns[-1][0]:.1f} m3/kg")

    # ------------------------------------------------------------------
    # Seam self-check: re-solve the top two existing points of each column.
    # ------------------------------------------------------------------
    worst_T = worst_P = 0.0
    for v, col in columns:
        for p in col[-2:]:
            r = solve_column_point(p['u'], v, p['T_K'] - 5.0, p['T_K'] + 5.0)
            if not isinstance(r, dict):
                raise SystemExit(f"REFUSING: cannot re-solve existing point u={p['u']} v={v}")
            worst_T = max(worst_T, abs(r['T_K'] - p['T_K']))
            worst_P = max(worst_P, abs(r['P_MPa'] - p['P_MPa']) / p['P_MPa'])
    print(f"Seam self-check: worst dT = {worst_T:.5f} K, worst dP = {worst_P * 100:.5f}%")
    if worst_T > 0.02 or worst_P > 2e-4:
        raise SystemExit("REFUSING: patch solver does not reproduce the existing surface")

    added, no_root = [], []
    t0 = time.time()

    def march(v, u_start, T_below, T_top):
        """Rows u_start, u_start + U_STEP, ... up to T_top."""
        rows = []
        u = u_start
        while True:
            r = solve_column_point(u, v, T_below, T_top)
            if r is None:
                return rows                # past the limit on this column
            if r == 'no-root':
                no_root.append((u, v))     # region 2/5 boundary sliver
            else:
                rows.append({'u': float(u), 'v': v, **r, 'region': 'vapor', 'curve': None})
                T_below = r['T_K']
            u += U_STEP

    # ------------------------------------------------------------------
    # March each column upward to the (T_MAX, P_MAX) limit.
    # ------------------------------------------------------------------
    tops = []   # (v, top u, ends on the isobar?) of every extended column
    for i, (v, col) in enumerate(columns):
        top = col[-1]
        T_top = hottest_valid_T(top['T_K'], v)
        rows = march(v, top['u'] + U_STEP, top['T_K'], T_top)
        added.extend(rows)
        last = rows[-1] if rows else top
        tops.append((v, last['u'], T_top < T_MAX))
        print(f"  column {i + 1}/{len(columns)} v={v:.5g}: +{len(rows)} rows, top u={last['u']:.0f} "
              f"T={last['T_C']:.0f} C P={last['P_MPa']:.4g} MPa  ({time.time() - t0:.0f}s)",
              flush=True)

    # ------------------------------------------------------------------
    # Fringe columns between neighbours on the sloped 50 MPa edge.
    # ------------------------------------------------------------------
    n_fringe_cols = n_fringe_pts = 0
    for (va, ua, a_on_isobar), (vb, ub, _) in zip(tops, tops[1:]):
        if not a_on_isobar or ub - ua <= FRINGE_TOP_STEP:
            continue
        n = math.ceil((ub - ua) / FRINGE_TOP_STEP) - 1
        for k in range(1, n + 1):
            v = float(va * (vb / va) ** (k / (n + 1)))
            T_top = hottest_valid_T(T_FRINGE_LOW, v)
            u_top = u_at(T_top, v)
            # Rows on the left neighbour's 20 kJ/kg lattice, from FRINGE_DEPTH
            # below this column's own top, never below the old top.
            u_start = max(u_top - FRINGE_DEPTH, U_OLD_TOP)
            u_start = ua + U_STEP * math.ceil((u_start - ua) / U_STEP)
            rows = march(v, u_start, T_FRINGE_LOW, T_top)
            added.extend(rows)
            n_fringe_cols += 1
            n_fringe_pts += len(rows)
    print(f"Fringe: {n_fringe_cols} columns, {n_fringe_pts} points  ({time.time() - t0:.0f}s)")

    print(f"Done: {len(added)} added, {len(no_root)} targets with no IF97 solution")
    for u, v in no_root:
        print(f"  no solution: u={u:.0f} v={v:.6g}")
    if len(no_root) > len(columns) + n_fringe_cols:
        raise SystemExit("REFUSING: more unsolved targets than the region 2/5 boundary explains")
    if len(added) == 0:
        raise SystemExit("REFUSING: nothing to add")

    # ------------------------------------------------------------------
    # Merge - existing points carried through untouched - and write.
    # ------------------------------------------------------------------
    merged = points + added
    data['points'] = merged
    data['n_points'] = len(merged)
    data['description'] = (data.get('description', '') +
                           ' + hot patch (full-height vapor columns extended from u=3300 to '
                           '2273.15 K / 50 MPa, fringe columns under the 50 MPa edge; same '
                           'IAPWS-IF97 source, seam-checked)')
    text = json.dumps(data, indent=2)
    # LF on every platform: .gitattributes pins these files to eol=lf.
    GRID_PATH.write_text(text, newline='\n')
    # The runtime loads TWO copies: public/ in the browser, scripts/ in Node
    # (see loadDataSync in water-properties-v4.ts). Keep them identical.
    (HERE / 'uv_grid_data_v13_filtered.json').write_text(text, newline='\n')
    print(f"Wrote {GRID_PATH} (+ scripts copy) with {len(merged)} points")


if __name__ == '__main__':
    main()
