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
      "List buildable component types. With no arguments returns just the type keys and display names (cheap). Pass types=[...] to get the full property schema (property names, units, ranges, defaults, help) for those types. Fetch a type's schema before the first time you add or edit that type in a conversation.",
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
      },
      required: ["type", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_component",
    description:
      "Change properties of an existing component (construction mode only). Provide only the properties you want to change. Returns the updated details or an error.",
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
];
