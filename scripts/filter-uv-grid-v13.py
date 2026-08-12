"""
Filter the v13 (u, v) grid to the pressure range the simulation actually uses.

build-uv-grid-v13.py solves for (T, P) across the whole grid, including points
well above 50 MPa. Those high-pressure points sit far outside anything a reactor
sandbox will reach, and they pull the interpolation stencil around in the region
we do care about, so they are dropped here.

This is the last step of the water-property chain:

    build-saturation-dome.py  ->  saturation_dome_iapws.json
    build-uv-grid-v5.py       ->  uv_grid_data_v5.json        (seed for v13)
    build-uv-grid-v13.py      ->  uv_grid_data_v13.json
    filter-uv-grid-v13.py     ->  uv_grid_data_v13_filtered.json   (this script)

Writes the result to both scripts/ (read by Node) and public/ (fetched by the
browser); water-properties-v4.ts loads it from whichever it is running under.
"""

import json
from pathlib import Path

MAX_PRESSURE_MPA = 50

scripts_dir = Path(__file__).parent
repo_root = scripts_dir.parent

src_path = scripts_dir / 'uv_grid_data_v13.json'
with open(src_path, 'r') as f:
    data = json.load(f)

points = data['points']
print(f"Loaded {len(points)} points from {src_path.name}")

kept = [pt for pt in points if pt['P_MPa'] <= MAX_PRESSURE_MPA]
dropped = [pt for pt in points if pt['P_MPa'] > MAX_PRESSURE_MPA]

print(f"Kept {len(kept)}, dropped {len(dropped)} above {MAX_PRESSURE_MPA} MPa")
if dropped:
    print("Dropped by region:")
    for region in ['compressed_liquid', 'vapor', 'supercritical']:
        count = sum(1 for pt in dropped if pt['region'] == region)
        if count > 0:
            print(f"  {region}: {count}")

output = {
    'description': f'Water properties on (u, v) grid - v13 filtered to P <= {MAX_PRESSURE_MPA} MPa',
    'n_points': len(kept),
    'max_pressure_MPa': MAX_PRESSURE_MPA,
    'points': kept,
}

for out_path in [scripts_dir / 'uv_grid_data_v13_filtered.json',
                 repo_root / 'public' / 'uv_grid_data_v13_filtered.json']:
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"Saved to {out_path}")
