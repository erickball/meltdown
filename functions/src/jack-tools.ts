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
