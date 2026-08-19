import type Anthropic from "@anthropic-ai/sdk";

// Tool definitions for Jack. These are declared server-side so the prompt
// prefix (tools -> system) stays byte-stable for prompt caching, but every
// tool is EXECUTED client-side in the browser against the live plant model.
// Property bags are intentionally loose (additionalProperties: true): the
// game's construction code is the validator, and its error messages are fed
// back to the model as tool_result errors.

export const JACK_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_component_types",
    description:
      "Get full property schemas (ranges, defaults, choices, help text) for component types. The compact catalog — every type key and its property names with units — is already in your first CONTEXT block, so for routine adds/edits you don't need this tool. Call it (with types=[...]) when you need valid ranges, defaults, or help for unfamiliar properties.",
    input_schema: {
      type: "object",
      properties: {
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Type keys to fetch full property schemas for (e.g. ['relief-valve'])",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_component_details",
    description:
      "Get the full property set and connections of one existing component in the plant, by its display name or id. Use before editing a component or sizing anything against it.",
    input_schema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description: "Display name or id of the component",
        },
      },
      required: ["component"],
      additionalProperties: false,
    },
  },
  {
    name: "get_simulation_state",
    description:
      "Get recent simulation readings (pressures, temperatures, liquid levels, flows, power) for specific components, or plant-wide key values if no components are given. Only meaningful when a simulation has been run.",
    input_schema: {
      type: "object",
      properties: {
        components: {
          type: "array",
          items: { type: "string" },
          description:
            "Display names or ids of components to read. Omit for a plant-wide summary.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_component",
    description:
      "Add a new component to the plant (construction mode only). Provide the component type, a name, and properties; unspecified properties get type defaults. Returns the created component's details, or an error explaining what was invalid.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Component type from list_component_types",
        },
        name: { type: "string", description: "Display name for the new component" },
        properties: {
          type: "object",
          description:
            "Component properties, in the units listed in the component catalog for each property (typically bar, °C, %, MW, m — NOT raw SI). Unspecified properties use defaults.",
        },
        containedBy: {
          type: "string",
          description:
            "Optional: name of a building/containment the component should be placed inside",
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["x", "y"],
          additionalProperties: false,
          description:
            "Optional plan-view position in meters. Building footprints are in the plant overview — pick a position inside the right building's footprint. If omitted: center of containedBy's footprint when given, else auto-placed beside the existing plant.",
        },
      },
      required: ["type", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "move_component",
    description:
      "Move an existing component to a new plan-view position (meters, construction mode only). Building containment (containedBy) is updated automatically from the destination: inside a building's footprint means contained by it. Check footprints in the plant overview before moving something into or out of containment.",
    input_schema: {
      type: "object",
      properties: {
        component: { type: "string", description: "Display name or id" },
        x: { type: "number", description: "Plan x in meters" },
        y: { type: "number", description: "Plan y in meters" },
      },
      required: ["component", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_component",
    description:
      "Change properties of an existing component (construction mode only). Any property in the parts catalog can be edited, in catalog units; provide only the properties you want to change. Property names that don't exist in the catalog are rejected or flagged as ignored — never report those as changed. Use move_component for position. Returns the updated details or an error.",
    input_schema: {
      type: "object",
      properties: {
        component: { type: "string", description: "Display name or id" },
        changes: {
          type: "object",
          description: "Map of property name to new value",
        },
      },
      required: ["component", "changes"],
      additionalProperties: false,
    },
  },
  {
    name: "connect_components",
    description:
      "Create a flow connection (pipe) between two components (construction mode only). Ports and pipe properties are optional; sensible defaults are used.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source component name or id" },
        to: { type: "string", description: "Destination component name or id" },
        fromPort: {
          type: "string",
          description:
            "Optional port name on the source (e.g. 'outlet', 'steam-out'). Defaults to the first free outward port.",
        },
        toPort: {
          type: "string",
          description:
            "Optional port name on the destination. Defaults to the first free inward port.",
        },
        properties: {
          type: "object",
          description:
            "Optional flowpath properties: flowArea (m²) or diameter (m), length (m), fromElevation / toElevation (m above each component's bottom)",
        },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_component",
    description:
      "Remove a component and its connections from the plant (construction mode only). Confirm with the user before calling this unless they explicitly asked for the deletion.",
    input_schema: {
      type: "object",
      properties: {
        component: { type: "string", description: "Display name or id" },
      },
      required: ["component"],
      additionalProperties: false,
    },
  },
  {
    name: "list_state_paths",
    description:
      "Explore the raw simulation state tree to find plottable quantities. Give a dot-path and get the children at that level (empty path = top level: flowNodes, flowConnections, thermalNodes, neutronics, burstStates, ...). Values are RAW SI (Pa, K, kg, W, kg/s). Use this to discover exact paths for query_history and plot_history; error messages also list valid keys when a path is wrong.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Dot-path to inspect, e.g. 'flowNodes', 'flowNodes.hx-1-tube.fluid', 'neutronics'. Omit or empty for the top level. Map keys and array element ids are path segments.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "query_history",
    description:
      "Sample recorded time histories of numeric state values (raw SI units) for your OWN analysis - the user does not see this. Give up to 8 dot-paths (see list_state_paths); returns time and value arrays downsampled to maxPoints, plus min/max/first/last per path. Recent history has ~per-frame resolution; older history is sparser. Use plot_history when the user should SEE a chart.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Dot-paths to numeric values, e.g. ['flowNodes.tan-2.fluid.pressure', 'neutronics.power']. Booleans (e.g. neutronics.scrammed) sample as 0/1.",
        },
        tMinS: { type: "number", description: "Start of time range (sim seconds). Omit for all history." },
        tMaxS: { type: "number", description: "End of time range (sim seconds). Omit for now." },
        maxPoints: { type: "number", description: "Max samples returned (default 40, cap 200)." },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "plot_history",
    description:
      "Draw a line chart of recorded state values over time, in a floating panel the user sees immediately (they can move, resize, and minimize it; it persists with saved configurations). Fully generic: up to 10 series by dot-path, each with an optional label, left/right axis, and linear transform (plotted = raw*scale + offset - use this for units: Pa to bar scale=1e-5, K to degC offset=-273.15, W to MW scale=1e-6). Optional log axes, time range, and vertical annotation lines (e.g. at a scram or rupture time). A plot WITHOUT tMaxS stays LIVE - it keeps extending as the simulation runs, and if the user rewinds it keeps showing the full recorded history with a 'now' marker at their current position; give tMaxS to freeze a finished exhibit. Reusing a figureId redraws that panel; a new figureId opens a second chart. Label axes with the DISPLAY units you converted to.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Chart title shown to the user" },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Dot-path to a numeric state value" },
              label: { type: "string", description: "Legend label (default: the path)" },
              axis: { type: "string", enum: ["left", "right"], description: "Y axis (default left)" },
              scale: { type: "number", description: "Multiply raw value (default 1)" },
              offset: { type: "number", description: "Add after scaling (default 0)" },
            },
            required: ["path"],
            additionalProperties: false,
          },
          description: "Series to plot (max 10). Put quantities with different magnitudes on separate axes.",
        },
        yLabel: { type: "string", description: "Left axis label, with units, e.g. 'Pressure (bar)'" },
        y2Label: { type: "string", description: "Right axis label, with units" },
        logY: { type: "boolean", description: "Log scale on the left axis" },
        logY2: { type: "boolean", description: "Log scale on the right axis" },
        tMinS: { type: "number", description: "Start of time range (sim seconds). Omit for all history." },
        tMaxS: { type: "number", description: "End of time range (sim seconds). Omit for now." },
        maxPoints: { type: "number", description: "Max points per series (default 400, cap 2000)" },
        annotations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timeS: { type: "number", description: "Sim time of the vertical marker line" },
              label: { type: "string", description: "Short label shown at the line" },
            },
            required: ["timeS"],
            additionalProperties: false,
          },
          description: "Vertical dashed marker lines, e.g. at a scram or rupture (max 12)",
        },
        figureId: {
          type: "string",
          description: "Panel identity. Same id = replace that chart; new id = open another panel.",
        },
      },
      required: ["series"],
      additionalProperties: false,
    },
  },
  {
    name: "file_car",
    description:
      "File a Corrective Action Report (CAR) - a bug report for the game's developers. Use when the user reports (or you observe) behavior that looks like a defect in the game itself: physics that can't be right, UI that misbehaves, tools that error on valid input, numbers that contradict each other. Not for player mistakes or design questions. Summarize the problem factually; game context (mode, sim time, selection) is attached automatically.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "One-line summary of the suspected defect",
        },
        description: {
          type: "string",
          description:
            "What happened, what was expected, and how to reproduce it as far as known",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "low = cosmetic/annoyance, medium = wrong behavior with a workaround, high = blocks play or corrupts the plant",
        },
        component: {
          type: "string",
          description: "Optional: the component or subsystem involved",
        },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
  },
];
