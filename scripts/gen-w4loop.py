"""Generate the Westinghouse 4-loop PWR preset (src/presets/w4loop.json).

~3400 MWt / ~1150 MWe, 4 primary loops (SG + RCP each), pressurizer with
PORV + code safety valve discharging to a PRT, per-SG feedwater trains with
check valves and 3-element level control, MSSVs on each steam line, a
turbine-driven AFW pump fed from the CST, 4 N2-charged accumulators, and
HPI/LPI pumps drawing from the RWST. Scenario levers: break valve on a cold
leg (LOCA), pump trips (SBO).
"""
import json

C = []  # [id, component] pairs
X = []  # connections


def add(comp):
    C.append([comp["id"], comp])


def conn(f, fp, t, tp, fe, te, area, length, rc=None, flow=None, fpt=None, tpt=None):
    c = {"fromComponentId": f, "fromPortId": fp, "toComponentId": t, "toPortId": tp,
         "fromElevation": fe, "toElevation": te, "flowArea": area, "length": length}
    if rc is not None:
        c["resistanceCoeff"] = rc
    if flow is not None:
        c["initialFlowRate"] = flow
    if fpt is not None:
        c["fromPhaseTolerance"] = fpt
    if tpt is not None:
        c["toPhaseTolerance"] = tpt
    X.append(c)


P155 = 15.5e6
PRIM_HOT = {"temperature": 592, "pressure": P155, "phase": "liquid", "quality": 0, "flowRate": 0}
PRIM = {"temperature": 565, "pressure": P155, "phase": "liquid", "quality": 0, "flowRate": 0}
SEC = {"temperature": 549, "pressure": 6.0e6, "phase": "two-phase", "quality": 0.02, "flowRate": 0}
COND = {"temperature": 306, "pressure": 5000, "phase": "liquid", "quality": 0, "flowRate": 0}

# ---------------------------------------------------------------- buildings
add({"id": "bui-1", "type": "building", "label": "Containment",
     "position": {"x": 48, "y": 80}, "rotation": 0, "elevation": 0,
     "shape": "cylinder", "height": 52, "diameter": 44, "wallThickness": 1.1, "steelFraction": 0.05,
     "pressureRating": 5, "fillLevel": 0,
     "ports": [{"id": "bui-1-east", "position": {"x": 22, "y": 0}, "direction": "both"}],
     "fluid": {"temperature": 293, "pressure": 101325, "phase": "vapor", "quality": 1, "flowRate": 0},
     "initialNcg": {"N2": 0.78, "O2": 0.21, "Ar": 0.009}, "nqa1": True})

# Environment sink for MSSV / AFW-turbine exhaust: a huge vented shed at
# atmospheric pressure. Steam dumped here is lost to the plant, as it should
# be; its pressure barely moves (2e6 m3 of air).
add({"id": "env-1", "type": "building", "label": "Atmosphere (steam discharge)",
     "position": {"x": 160, "y": 40}, "rotation": 0, "elevation": 0,
     "shape": "rectangle", "height": 50, "width": 200, "length": 200,
     "wallThickness": 0.1, "steelFraction": 1.0,
     "pressureRating": 2, "fillLevel": 0,
     "ports": [{"id": "env-1-in", "position": {"x": -100, "y": 0}, "direction": "both"}],
     "fluid": {"temperature": 293, "pressure": 101325, "phase": "vapor", "quality": 1, "flowRate": 0},
     "initialNcg": {"N2": 0.78, "O2": 0.21, "Ar": 0.009}, "nqa1": False})

# ---------------------------------------------------------------- RPV + core
add({"id": "rv-1", "type": "reactorVessel", "label": "RPV",
     "position": {"x": 48, "y": 80}, "rotation": 0, "elevation": 0,
     "innerDiameter": 4.4, "wallThickness": 0.22, "height": 12, "pressureRating": 172, "fillLevel": 1.0,
     "barrelDiameter": 3.7, "barrelThickness": 0.06, "barrelBottomGap": 1, "barrelTopGap": 1,
     "coreBarrelId": "cb-1",
     "ports": [
         {"id": "rv-1-cold-leg-1", "position": {"x": -2.2, "y": -0.8}, "direction": "both"},
         {"id": "rv-1-cold-leg-2", "position": {"x": -2.2, "y": 0.8}, "direction": "both"},
         {"id": "rv-1-cold-leg-3", "position": {"x": 2.2, "y": -0.8}, "direction": "both"},
         {"id": "rv-1-cold-leg-4", "position": {"x": 2.2, "y": 0.8}, "direction": "both"},
         {"id": "rv-1-core-in", "position": {"x": 0, "y": 2}, "direction": "both"},
         {"id": "rv-1-surge", "position": {"x": 2, "y": -3}, "direction": "both"},
         {"id": "rv-1-spray-out", "position": {"x": 1.5, "y": -4}, "direction": "out"},
         {"id": "rv-1-break", "position": {"x": -1.5, "y": -4}, "direction": "both"}
     ],
     "fluid": dict(PRIM), "nqa1": True, "containedBy": "bui-1"})

add({"id": "cb-1", "type": "coreBarrel", "label": "Core",
     "position": {"x": 48, "y": 80}, "rotation": 0, "elevation": 1,
     "innerDiameter": 3.7, "thickness": 0.06, "height": 10, "bottomGap": 1, "topGap": 1,
     "fuelRodCount": 8, "actualFuelRodCount": 50952, "fuelTemperature": 570, "fuelMeltingPoint": 2800,
     "activeFuelHeight": 3.66, "coreBottomElevation": 0.3,
     "controlRodCount": 4, "controlRodPosition": 0.85,
     "initializeCritical": True, "excessReactivity": 0.032, "controlRodWorth": 0.09,
     "thermalPower": 3400000000, "initialPower": 500000000, "decayHeatPower": 3400000000, "coolantDensityCoeff": 0.0002,
     "ports": [
         {"id": "cb-1-inlet", "position": {"x": 0, "y": 5}, "direction": "both"},
         {"id": "cb-1-outlet", "position": {"x": 0, "y": -5}, "direction": "both"}
     ],
     "fluid": {"temperature": 567, "pressure": P155, "phase": "liquid", "quality": 0, "flowRate": 0},
     "nqa1": True, "containedBy": "rv-1"})

conn("rv-1", "rv-1-core-in", "cb-1", "cb-1-inlet", 0.5, 0, 7.5, 1, rc=3, flow=17600)

# ---------------------------------------------------------------- 4 loops
sg_pos = [(63, 70), (33, 70), (63, 90), (33, 90)]
pump_pos = [(58, 75), (38, 75), (58, 85), (38, 85)]
for i in range(1, 5):
    sx, sy = sg_pos[i - 1]
    px, py = pump_pos[i - 1]
    add({"id": f"hx-{i}", "type": "heatExchanger", "label": f"SG {'ABCD'[i-1]}",
         "position": {"x": sx, "y": sy}, "rotation": 0, "elevation": 0,
         "width": 4.5, "height": 13, "hxType": "utube", "tubeCount": 5626,
         "pressureRating": 100, "tubePressureRating": 172, "shellPressureRating": 100,
         "plenumLength": 1, "tubeOD": 0.0175,
         "ports": [
             {"id": f"hx-{i}-tube-1", "position": {"x": -0.6, "y": 6}, "direction": "both"},
             {"id": f"hx-{i}-tube-2", "position": {"x": 0.6, "y": 6}, "direction": "both"},
             {"id": f"hx-{i}-shell-1", "position": {"x": -2, "y": -6}, "direction": "both"},
             {"id": f"hx-{i}-shell-2", "position": {"x": 2, "y": 0}, "direction": "both"}
         ],
         "primaryFluid": {"temperature": 566, "pressure": P155, "phase": "liquid", "quality": 0, "flowRate": 0},
         "secondaryFluid": dict(SEC), "nqa1": True, "containedBy": "bui-1"})

    add({"id": f"pump-{i}", "type": "pump", "label": f"RCP {'ABCD'[i-1]}",
         "position": {"x": px, "y": py}, "rotation": 0, "elevation": 0,
         "diameter": 0.8, "running": True, "speed": 1.0, "ratedFlow": 4700, "ratedHead": 90,
         "pressureRating": 172, "orientation": "left-right",
         "ports": [
             {"id": f"pump-{i}-inlet", "position": {"x": -0.5, "y": 0}, "direction": "in"},
             {"id": f"pump-{i}-outlet", "position": {"x": 0.5, "y": 0}, "direction": "out"}
         ],
         "fluid": dict(PRIM), "nqa1": True, "containedBy": "bui-1"})

    # hot leg / SG / crossover / cold leg
    conn("cb-1", "cb-1-outlet", f"hx-{i}", f"hx-{i}-tube-1", 10, 1, 0.42, 8, rc=3, flow=4400)
    conn(f"hx-{i}", f"hx-{i}-tube-2", f"pump-{i}", f"pump-{i}-inlet", 1, 0, 0.45, 6, rc=3, flow=4400)
    conn(f"pump-{i}", f"pump-{i}-outlet", "rv-1", f"rv-1-cold-leg-{i}", 0, 6, 0.4, 8, rc=3, flow=4400)

# ---------------------------------------------------------------- pressurizer
add({"id": "pzr-1", "type": "tank", "label": "Pressurizer",
     "position": {"x": 53, "y": 68}, "rotation": 0, "elevation": 12,
     "width": 2.5, "height": 12, "wallThickness": 0.15, "fillLevel": 0.55, "pressureRating": 172,
     "heaterCapacity": 1800000,
     "ports": [
         {"id": "pzr-1-bottom", "position": {"x": 0, "y": 6}, "direction": "both"},
         {"id": "pzr-1-spray", "position": {"x": 0, "y": -6}, "direction": "in"},
         {"id": "pzr-1-porv", "position": {"x": -0.8, "y": -6}, "direction": "both"},
         {"id": "pzr-1-srv", "position": {"x": 0.8, "y": -6}, "direction": "both"}
     ],
     "fluid": {"temperature": 618, "pressure": P155, "phase": "two-phase", "quality": 0.05, "flowRate": 0},
     "nqa1": True, "containedBy": "bui-1"})

conn("rv-1", "rv-1-surge", "pzr-1", "pzr-1-bottom", 9, 0, 0.05, 5)

add({"id": "val-spray-1", "type": "valve", "label": "Pzr Spray Valve", "valveType": "globe",
     "position": {"x": 50, "y": 66}, "rotation": 0, "elevation": 22,
     "diameter": 0.08, "opening": 0, "volume": 0.1, "pressureRating": 172,
     "ports": [
         {"id": "val-spray-1-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
         {"id": "val-spray-1-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
     ],
     "fluid": dict(PRIM), "nqa1": True, "containedBy": "bui-1"})
conn("rv-1", "rv-1-spray-out", "val-spray-1", "val-spray-1-in", 11, 0, 0.001, 15)
conn("val-spray-1", "val-spray-1-out", "pzr-1", "pzr-1-spray", 0, 11.5, 0.001, 8)

# PORV + code safety, discharging to the PRT sparger (below water level)
add({"id": "val-porv-1", "type": "valve", "label": "Pzr PORV", "valveType": "porv",
     "position": {"x": 51, "y": 62}, "rotation": 0, "elevation": 25,
     "diameter": 0.1, "opening": 0, "volume": 0.15, "pressureRating": 180,
     "setpoint": 16200000, "blowdown": 0.04, "controlMode": "auto", "hasBlockValve": True,
     "ports": [
         {"id": "val-porv-1-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
         {"id": "val-porv-1-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
     ],
     "fluid": {"temperature": 618, "pressure": P155, "phase": "vapor", "quality": 1, "flowRate": 0},
     "nqa1": True, "containedBy": "bui-1"})
add({"id": "val-srv-1", "type": "valve", "label": "Pzr Safety Valve", "valveType": "relief",
     "position": {"x": 55, "y": 62}, "rotation": 0, "elevation": 25,
     "diameter": 0.15, "opening": 0, "volume": 0.15, "pressureRating": 190,
     "setpoint": 17100000, "blowdown": 0.06,
     "ports": [
         {"id": "val-srv-1-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
         {"id": "val-srv-1-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
     ],
     "fluid": {"temperature": 618, "pressure": P155, "phase": "vapor", "quality": 1, "flowRate": 0},
     "nqa1": True, "containedBy": "bui-1"})
add({"id": "prt-1", "type": "tank", "label": "Pressurizer Relief Tank",
     "position": {"x": 58, "y": 62}, "rotation": 0, "elevation": 0,
     "width": 3.6, "height": 5, "wallThickness": 0.04, "fillLevel": 0.75, "pressureRating": 7,
     "ports": [{"id": "prt-1-in", "position": {"x": 0, "y": -2.5}, "direction": "both"}],
     "fluid": {"temperature": 320, "pressure": 10500, "phase": "two-phase", "quality": 0.001, "flowRate": 0},
     "initialNcg": {"N2": 0.9}, "nqa1": True, "containedBy": "bui-1"})

# inlet connection FIRST, outlet LAST (check/relief valves throttle the
# most-recently-linked connection - keep the block point on the outlet)
conn("pzr-1", "pzr-1-porv", "val-porv-1", "val-porv-1-in", 11.8, 0, 0.008, 3, fpt=0)
conn("val-porv-1", "val-porv-1-out", "prt-1", "prt-1-in", 0, 0.5, 0.008, 12)
conn("pzr-1", "pzr-1-srv", "val-srv-1", "val-srv-1-in", 11.8, 0, 0.018, 2, fpt=0)
conn("val-srv-1", "val-srv-1-out", "prt-1", "prt-1-in", 0, 0.5, 0.018, 10)

# ---------------------------------------------------------------- LOCA lever
add({"id": "val-break-1", "type": "valve", "label": "Cold Leg Break (scenario)", "valveType": "gate",
     "position": {"x": 42, "y": 92}, "rotation": 0, "elevation": 5,
     "diameter": 0.2, "opening": 0, "volume": 0.2, "pressureRating": 180,
     "ports": [
         {"id": "val-break-1-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
         {"id": "val-break-1-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
     ],
     "fluid": dict(PRIM), "nqa1": True, "containedBy": "bui-1"})
conn("rv-1", "rv-1-break", "val-break-1", "val-break-1-in", 5.5, 0, 0.031, 2)
conn("val-break-1", "val-break-1-out", "bui-1", "bui-1-east", 0, 5, 0.031, 2)

# ---------------------------------------------------------------- steam plant
add({"id": "turbine-1", "type": "turbine-generator", "label": "Turbine-Generator",
     "position": {"x": 95, "y": 75}, "rotation": 0, "elevation": 0,
     "width": 20, "height": 5, "orientation": "left-right", "stages": 1,
     "running": True, "power": 0, "ratedPower": 1150000000, "ratedSteamFlow": 1500,
     "efficiency": 0.85, "governorValve": 0.12, "generatorEfficiency": 0.98,
     "ports": [
         {"id": "inlet", "position": {"x": -10, "y": 0}, "direction": "in"},
         {"id": "outlet", "position": {"x": 10, "y": 0}, "direction": "out"}
     ],
     "designInletPressure": 6.0e6,
     "inletFluid": {"temperature": 319, "pressure": 1.0e4, "phase": "vapor", "quality": 1, "flowRate": 0},
     "outletFluid": {"temperature": 306, "pressure": 5000, "phase": "two-phase", "quality": 0.9, "flowRate": 0},
     "nqa1": False})

add({"id": "condenser-1", "type": "condenser", "label": "Condenser",
     "position": {"x": 118, "y": 75}, "rotation": 0, "elevation": 3,
     "width": 12, "height": 7, "pressureRating": 2, "heatRejection": 0, "fillLevel": 0.08,
     "coolingWaterTemp": 293, "coolingWaterFlow": 90000, "coolingCapacity": 2400000000, "tubeCount": 40000,
     "ports": [
         {"id": "condenser-1-inlet", "position": {"x": -5, "y": -3.5}, "direction": "in"},
         {"id": "condenser-1-bottom", "position": {"x": 0, "y": 3.5}, "direction": "out"}
     ],
     "fluid": {"temperature": 306, "pressure": 5000, "phase": "two-phase", "quality": 0.1, "flowRate": 0},
     "nqa1": False})

add({"id": "cond-pump-1", "type": "pump", "label": "Condensate Pump",
     "position": {"x": 118, "y": 84}, "rotation": 0, "elevation": 0,
     "diameter": 0.6, "running": True, "speed": 0.6, "ratedFlow": 2000, "ratedHead": 100,
     "pressureRating": 40, "orientation": "left-right",
     "ports": [
         {"id": "cond-pump-1-inlet", "position": {"x": -0.3, "y": 0}, "direction": "in"},
         {"id": "cond-pump-1-outlet", "position": {"x": 0.3, "y": 0}, "direction": "out"}
     ],
     "fluid": dict(COND), "nqa1": False})

conn("turbine-1", "outlet", "condenser-1", "condenser-1-inlet", 0, 5, 1.0, 5)
conn("condenser-1", "condenser-1-bottom", "cond-pump-1", "cond-pump-1-inlet", 0.1, 0, 0.3, 3)

for i in range(1, 5):
    # steam line to turbine
    conn(f"hx-{i}", f"hx-{i}-shell-1", "turbine-1", "inlet", 11, 0, 0.1, 40, flow=320)
    # MSSV off each steam line -> atmosphere
    add({"id": f"val-mssv-{i}", "type": "valve", "label": f"MSSV {'ABCD'[i-1]}", "valveType": "relief",
         "position": {"x": 70 + 3 * i, "y": 58}, "rotation": 0, "elevation": 15,
         "diameter": 0.15, "opening": 0, "volume": 0.2, "pressureRating": 100,
         "setpoint": 7200000, "blowdown": 0.05,
         "ports": [
             {"id": f"val-mssv-{i}-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
             {"id": f"val-mssv-{i}-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
         ],
         "fluid": {"temperature": 549, "pressure": 6.0e6, "phase": "vapor", "quality": 1, "flowRate": 0},
         "nqa1": True})
    conn(f"hx-{i}", f"hx-{i}-shell-1", f"val-mssv-{i}", f"val-mssv-{i}-in", 11, 0, 0.018, 3)
    conn(f"val-mssv-{i}", f"val-mssv-{i}-out", "env-1", "env-1-in", 0, 20, 0.018, 8)

    # feedwater train: cond pump header -> FW pump -> check valve -> SG
    add({"id": f"fw-pump-{i}", "type": "pump", "label": f"FW Pump {'ABCD'[i-1]}",
         "position": {"x": 104, "y": 80 + 2 * i}, "rotation": 0, "elevation": 0,
         "diameter": 0.5, "running": True, "speed": 0.5, "ratedFlow": 520, "ratedHead": 650,
         "pressureRating": 100, "orientation": "left-right",
         "ports": [
             {"id": f"fw-pump-{i}-inlet", "position": {"x": -0.3, "y": 0}, "direction": "in"},
             {"id": f"fw-pump-{i}-outlet", "position": {"x": 0.3, "y": 0}, "direction": "out"}
         ],
         "fluid": dict(COND), "nqa1": False})
    add({"id": f"val-fwcv-{i}", "type": "valve", "label": f"FW Check Valve {'ABCD'[i-1]}", "valveType": "check",
         "position": {"x": 98, "y": 80 + 2 * i}, "rotation": 0, "elevation": 0,
         "diameter": 0.25, "opening": 0, "crackingPressure": 10000, "volume": 0.6,
         "ports": [
             {"id": f"val-fwcv-{i}-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
             {"id": f"val-fwcv-{i}-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
         ],
         "fluid": dict(COND), "nqa1": True})
    conn("cond-pump-1", "cond-pump-1-outlet", f"fw-pump-{i}", f"fw-pump-{i}-inlet", 0, 0, 0.1, 15)
    conn(f"fw-pump-{i}", f"fw-pump-{i}-outlet", f"val-fwcv-{i}", f"val-fwcv-{i}-in", 0, 0, 0.09, 3)
    conn(f"val-fwcv-{i}", f"val-fwcv-{i}-out", f"hx-{i}", f"hx-{i}-shell-2", 0, 6, 0.09, 7)

# ---------------------------------------------------------------- AFW (TD pump + CST)
add({"id": "cst-1", "type": "tank", "label": "Condensate Storage Tank",
     "position": {"x": 140, "y": 95}, "rotation": 0, "elevation": 0,
     "width": 12, "height": 15, "wallThickness": 0.02, "fillLevel": 0.95, "pressureRating": 2,
     "ports": [{"id": "cst-1-bottom", "position": {"x": 0, "y": 7.5}, "direction": "both"}],
     "fluid": {"temperature": 300, "pressure": 3600, "phase": "two-phase", "quality": 0.0001, "flowRate": 0},
     "initialNcg": {"N2": 0.78, "O2": 0.21}, "nqa1": True})

add({"id": "afw-td-1", "type": "turbine-driven-pump", "label": "TD AFW Pump",
     "position": {"x": 132, "y": 60}, "rotation": 0, "elevation": 0,
     "width": 4, "height": 1.5, "orientation": "left-right", "stages": 1, "running": True,
     "ratedSteamFlow": 8, "turbineEfficiency": 0.7, "governorValve": 0,
     "pumpFlow": 0, "ratedPumpFlow": 90, "ratedHead": 900, "pumpEfficiency": 0.75,
     "inletFluid": {"temperature": 549, "pressure": 6.0e6, "phase": "vapor", "quality": 1, "flowRate": 0},
     "outletFluid": {"temperature": 373, "pressure": 150000, "phase": "two-phase", "quality": 0.9, "flowRate": 0},
     "ports": [
         {"id": "afw-td-1-steam-inlet", "position": {"x": -2, "y": -0.5}, "direction": "in"},
         {"id": "afw-td-1-steam-exhaust", "position": {"x": -2, "y": 0.5}, "direction": "out"},
         {"id": "afw-td-1-pump-suction", "position": {"x": 2, "y": 0.5}, "direction": "in"},
         {"id": "afw-td-1-pump-discharge", "position": {"x": 2, "y": -0.5}, "direction": "out"}
     ],
     "nqa1": True})

conn("hx-1", "hx-1-shell-1", "afw-td-1", "afw-td-1-steam-inlet", 11, 1.2, 0.01, 30)
conn("afw-td-1", "afw-td-1-steam-exhaust", "env-1", "env-1-in", 1.0, 5, 0.02, 12)
conn("cst-1", "cst-1-bottom", "afw-td-1", "afw-td-1-pump-suction", 0.2, 0.3, 0.05, 25, tpt=0)

for i in range(1, 5):
    add({"id": f"val-afwcv-{i}", "type": "valve", "label": f"AFW Check Valve {'ABCD'[i-1]}", "valveType": "check",
         "position": {"x": 90, "y": 56 + 2 * i}, "rotation": 0, "elevation": 0,
         "diameter": 0.1, "opening": 0, "crackingPressure": 10000, "volume": 0.08,
         "ports": [
             {"id": f"val-afwcv-{i}-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
             {"id": f"val-afwcv-{i}-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
         ],
         "fluid": {"temperature": 300, "pressure": 100000, "phase": "liquid", "quality": 0, "flowRate": 0},
         "nqa1": True})
    conn("afw-td-1", "afw-td-1-pump-discharge", f"val-afwcv-{i}", f"val-afwcv-{i}-in", 0.3, 0, 0.008, 25)
    conn(f"val-afwcv-{i}", f"val-afwcv-{i}-out", f"hx-{i}", f"hx-{i}-shell-2", 0, 6, 0.008, 8)

# ---------------------------------------------------------------- ECCS
for i in range(1, 5):
    add({"id": f"acc-{i}", "type": "tank", "label": f"Accumulator {'ABCD'[i-1]}",
         "position": {"x": 30 + 12 * (i - 1), "y": 100}, "rotation": 0, "elevation": 2,
         "width": 3.0, "height": 5.7, "wallThickness": 0.09, "fillLevel": 0.72, "pressureRating": 60,
         "ports": [{"id": f"acc-{i}-bottom", "position": {"x": 0, "y": 2.85}, "direction": "both"}],
         "fluid": {"temperature": 306, "pressure": 5000, "phase": "two-phase", "quality": 0.0001, "flowRate": 0},
         "initialNcg": {"N2": 41}, "nqa1": True, "containedBy": "bui-1"})
    add({"id": f"val-acccv-{i}", "type": "valve", "label": f"Accumulator Check Valve {'ABCD'[i-1]}", "valveType": "check",
         "position": {"x": 31 + 12 * (i - 1), "y": 95}, "rotation": 0, "elevation": 1,
         "diameter": 0.25, "opening": 0, "crackingPressure": 10000, "volume": 0.15,
         "ports": [
             {"id": f"val-acccv-{i}-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
             {"id": f"val-acccv-{i}-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
         ],
         "fluid": {"temperature": 306, "pressure": 4200000, "phase": "liquid", "quality": 0, "flowRate": 0},
         "nqa1": True, "containedBy": "bui-1"})
    conn(f"acc-{i}", f"acc-{i}-bottom", f"val-acccv-{i}", f"val-acccv-{i}-in", 0.1, 0, 0.05, 8, rc=15, fpt=0)
    conn(f"val-acccv-{i}", f"val-acccv-{i}-out", "rv-1", f"rv-1-cold-leg-{i}", 0, 6, 0.05, 4, rc=15)

add({"id": "rwst-1", "type": "tank", "label": "RWST",
     "position": {"x": 15, "y": 105}, "rotation": 0, "elevation": 0,
     "width": 10, "height": 17, "wallThickness": 0.02, "fillLevel": 0.97, "pressureRating": 2,
     "ports": [{"id": "rwst-1-bottom", "position": {"x": 0, "y": 8.5}, "direction": "both"}],
     "fluid": {"temperature": 300, "pressure": 3600, "phase": "two-phase", "quality": 0.0001, "flowRate": 0},
     "initialNcg": {"N2": 0.78, "O2": 0.21}, "nqa1": True})

add({"id": "hpi-pump-1", "type": "pump", "label": "HPI/Charging Pump",
     "position": {"x": 15, "y": 118}, "rotation": 0, "elevation": 0,
     "diameter": 0.3, "running": False, "speed": 1.0, "ratedFlow": 35, "ratedHead": 1800,
     "pressureRating": 200, "orientation": "left-right",
     "ports": [
         {"id": "hpi-pump-1-inlet", "position": {"x": -0.2, "y": 0}, "direction": "in"},
         {"id": "hpi-pump-1-outlet", "position": {"x": 0.2, "y": 0}, "direction": "out"}
     ],
     "fluid": {"temperature": 300, "pressure": 100000, "phase": "liquid", "quality": 0, "flowRate": 0},
     "nqa1": True})
add({"id": "val-hpicv-1", "type": "valve", "label": "HPI Check Valve", "valveType": "check",
     "position": {"x": 20, "y": 118}, "rotation": 0, "elevation": 1,
     "diameter": 0.1, "opening": 0, "crackingPressure": 10000, "volume": 0.08,
     "ports": [
         {"id": "val-hpicv-1-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
         {"id": "val-hpicv-1-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
     ],
     "fluid": {"temperature": 300, "pressure": 100000, "phase": "liquid", "quality": 0, "flowRate": 0},
     "nqa1": True})
conn("rwst-1", "rwst-1-bottom", "hpi-pump-1", "hpi-pump-1-inlet", 0.2, 0, 0.02, 30, tpt=0)
conn("hpi-pump-1", "hpi-pump-1-outlet", "val-hpicv-1", "val-hpicv-1-in", 0, 0, 0.008, 10)
conn("val-hpicv-1", "val-hpicv-1-out", "rv-1", "rv-1-cold-leg-1", 0, 6, 0.008, 15)

add({"id": "lpi-pump-1", "type": "pump", "label": "LPI/RHR Pump",
     "position": {"x": 15, "y": 122}, "rotation": 0, "elevation": 0,
     "diameter": 0.5, "running": False, "speed": 1.0, "ratedFlow": 440, "ratedHead": 120,
     "pressureRating": 40, "orientation": "left-right",
     "ports": [
         {"id": "lpi-pump-1-inlet", "position": {"x": -0.3, "y": 0}, "direction": "in"},
         {"id": "lpi-pump-1-outlet", "position": {"x": 0.3, "y": 0}, "direction": "out"}
     ],
     "fluid": {"temperature": 300, "pressure": 100000, "phase": "liquid", "quality": 0, "flowRate": 0},
     "nqa1": True})
add({"id": "val-lpicv-1", "type": "valve", "label": "LPI Check Valve", "valveType": "check",
     "position": {"x": 20, "y": 122}, "rotation": 0, "elevation": 1,
     "diameter": 0.2, "opening": 0, "crackingPressure": 10000, "volume": 0.12,
     "ports": [
         {"id": "val-lpicv-1-in", "position": {"x": -0.1, "y": 0}, "direction": "in"},
         {"id": "val-lpicv-1-out", "position": {"x": 0.1, "y": 0}, "direction": "out"}
     ],
     "fluid": {"temperature": 300, "pressure": 100000, "phase": "liquid", "quality": 0, "flowRate": 0},
     "nqa1": True})
conn("rwst-1", "rwst-1-bottom", "lpi-pump-1", "lpi-pump-1-inlet", 0.2, 0, 0.1, 30, tpt=0)
conn("lpi-pump-1", "lpi-pump-1-outlet", "val-lpicv-1", "val-lpicv-1-in", 0, 0, 0.03, 10)
conn("val-lpicv-1", "val-lpicv-1-out", "rv-1", "rv-1-cold-leg-2", 0, 6, 0.03, 15)

# ---------------------------------------------------------------- controllers
def controller(id_, label, pid, y):
    add({"id": id_, "type": "controller", "controllerType": "pid", "label": label,
         "position": {"x": 8, "y": y}, "rotation": 0, "elevation": 0,
         "width": 2, "height": 2, "ports": [], "pid": pid})


controller("ctl-rods-1", "Rod Control (T-avg)", {
    "sensor": {"kind": "node-temperature", "targetId": "rv-1"},
    "setpoint": 567, "powerLimit": 1.0,
    "actuator": {"kind": "control-rods", "targetId": "", "min": 0, "max": 1, "rateLimit": 0.001}
}, 40)

controller("ctl-sgp-1", "SG Pressure (Governor)", {
    "sensor": {"kind": "node-pressure", "targetId": "hx-1-shell"},
    "setpoint": 6000000, "invert": True,
    "actuator": {"kind": "governor-valve", "targetId": "turbine-1", "min": 0.02, "max": 1, "rateLimit": 0.05}
}, 43)

for i in range(1, 5):
    controller(f"ctl-sgl-{i}", f"SG {'ABCD'[i-1]} Level (3-elem FW)", {
        "sensor": {"kind": "node-level", "targetId": f"hx-{i}-shell"},
        "setpoint": 8.5,
        "feedforward": {"kind": "connection-flow", "targetId": f"flow-hx-{i}-turbine-1"},
        "actuator": {"kind": "pump-speed", "targetId": f"fw-pump-{i}", "min": 0.05, "max": 1, "rateLimit": 0.05}
    }, 43 + 3 * i)

controller("ctl-pzrh-1", "Pzr Pressure (Heaters)", {
    "sensor": {"kind": "node-pressure", "targetId": "pzr-1"},
    "setpoint": 15500000,
    "actuator": {"kind": "heater-power", "targetId": "pzr-1", "min": 0, "max": 1800000, "rateLimit": 360000}
}, 58)

controller("ctl-pzrs-1", "Pzr Pressure (Spray)", {
    "sensor": {"kind": "node-pressure", "targetId": "pzr-1"},
    "setpoint": 15800000, "invert": True,
    "actuator": {"kind": "valve-position", "targetId": "val-spray-1", "min": 0, "max": 1, "rateLimit": 0.05}
}, 61)

controller("ctl-hwl-1", "Hotwell Level (Cond Pump)", {
    "sensor": {"kind": "node-level", "targetId": "condenser-1"},
    "setpoint": 0.6, "invert": True,
    "actuator": {"kind": "pump-speed", "targetId": "cond-pump-1", "min": 0.05, "max": 1, "rateLimit": 0.1}
}, 64)

# TD AFW governor on SG A level: parked in manual/closed for normal ops;
# flipping it to auto is the operator action that starts AFW.
controller("ctl-afw-1", "TD AFW (SG A level)", {
    "sensor": {"kind": "node-level", "targetId": "hx-1-shell"},
    "setpoint": 8.0,
    "actuator": {"kind": "governor-valve", "targetId": "afw-td-1", "min": 0, "max": 1, "rateLimit": 0.1},
    "mode": "manual", "manualOutput": 0
}, 67)

# Scram system (game-level; headless scenario scripts read its setpoints)
add({"id": "ctl-scram-1", "type": "controller", "controllerType": "scram", "label": "Reactor Protection",
     "position": {"x": 8, "y": 37}, "rotation": 0, "elevation": 0, "width": 2, "height": 2, "ports": [],
     "connectedCoreId": "cb-1",
     "setpoints": {"highPower": 115, "lowPower": 5, "highFuelTemp": 0.92, "lowCoolantFlow": 3000}})

out = {"_comment": "Westinghouse 4-loop PWR (~3400 MWt / ~1150 MWe): 4x SG+RCP loops, "
                   "pressurizer with PORV+safety to PRT, per-SG FW trains, MSSVs, TD AFW pump from CST, "
                   "4x N2 accumulators, HPI/LPI from RWST. Scenario levers: val-break-1 (LOCA), "
                   "pump trips + ctl-afw-1 (SBO). Generated by gen_w4loop.py.",
       "components": C, "connections": X}
path = r"c:\Users\erick\source\meltdown\src\presets\w4loop.json"
with open(path, "w") as f:
    json.dump(out, f, indent=1)
print(f"wrote {path}: {len(C)} components, {len(X)} connections")
