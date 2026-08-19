// Connection configuration dialog for creating connections between components

import { PlantComponent, Port, Connection } from '../types';
import { getComponentVisualHeight } from '../render/components';
import { hasPinnedPortElevations } from './component-properties';
import { PIPE_SPECS, findMatchingPipeSpec, pipeSpecFlowArea } from './component-presets';

// Shared tooltip for the offtake opening-height inputs (edit form, both ends)
const OPENING_HEIGHT_TIP =
  "Vertical size of the offtake opening at this end. The draw averages the " +
  "vessel's liquid / froth / vapor profile over this span, so a moving level " +
  "hands off between phases gradually instead of stepping. Empty or 0 samples " +
  "a single point at the connection elevation.";

export interface ConnectionConfig {
  fromComponent: PlantComponent;
  toComponent: PlantComponent;
  fromPort: Port;
  toPort: Port;
  fromElevation: number;  // Elevation at from end (relative to component bottom)
  toElevation: number;    // Elevation at to end (relative to component bottom)
  flowArea: number;       // Cross-sectional area in m²
  length: number;         // Connection length in m
  createPipe: boolean;    // Whether to create an intermediate pipe
  pressureRating?: number; // bar - design pressure for the auto-created pipe (from the selected line spec)
}

// Result of editing an existing connection
export interface ConnectionEditResult {
  fromElevation: number;
  toElevation: number;
  flowArea: number;
  length: number;
  fromOpeningHeight?: number;  // m - offtake opening height; undefined = point sample
  toOpeningHeight?: number;    // m
}

export class ConnectionDialog {
  private dialog: HTMLElement;
  private titleElement: HTMLElement;
  private bodyElement: HTMLElement;
  private confirmButton: HTMLElement;
  private cancelButton: HTMLElement;
  private closeButton: HTMLElement;
  private currentCallback: ((config: ConnectionConfig | null) => void) | null = null;
  private currentEditCallback: ((result: ConnectionEditResult | null) => void) | null = null;
  private isEditMode: boolean = false;
  private fromComponent: PlantComponent | null = null;
  private toComponent: PlantComponent | null = null;
  private fromPort: Port | null = null;
  private toPort: Port | null = null;

  constructor() {
    this.dialog = document.getElementById('connection-dialog')!;
    this.titleElement = document.getElementById('connection-dialog-title')!;
    this.bodyElement = document.getElementById('connection-dialog-body')!;
    this.confirmButton = document.getElementById('connection-dialog-confirm')!;
    this.cancelButton = document.getElementById('connection-dialog-cancel')!;
    this.closeButton = this.dialog.querySelector('.connection-dialog-close')!;

    // Set up event handlers
    this.confirmButton.addEventListener('click', () => this.handleConfirm());
    this.cancelButton.addEventListener('click', () => this.handleCancel());
    this.closeButton.addEventListener('click', () => this.handleCancel());

    // Close on background click - but only if mousedown also started on backdrop
    // This prevents accidental closes when dragging to select text
    let mouseDownOnBackdrop = false;
    this.dialog.addEventListener('mousedown', (e) => {
      mouseDownOnBackdrop = (e.target === this.dialog);
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog && mouseDownOnBackdrop) {
        this.handleCancel();
      }
      mouseDownOnBackdrop = false;
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dialog.style.display !== 'none') {
        this.handleCancel();
      }
    });
  }

  show(
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    fromPort: Port,
    toPort: Port,
    callback: (config: ConnectionConfig | null) => void
  ) {
    this.fromComponent = fromComponent;
    this.toComponent = toComponent;
    this.fromPort = fromPort;
    this.toPort = toPort;
    this.currentCallback = callback;

    // Set title
    const fromName = fromComponent.label || fromComponent.id;
    const toName = toComponent.label || toComponent.id;
    this.titleElement.textContent = `Connect ${fromName} to ${toName}`;

    // Build form
    this.buildForm();

    // Show dialog
    this.dialog.style.display = 'flex';

    // Focus first input
    const firstInput = this.bodyElement.querySelector('input') as HTMLElement;
    if (firstInput) {
      firstInput.focus();
    }
  }

  private buildForm() {
    this.bodyElement.innerHTML = '';

    if (!this.fromComponent || !this.toComponent) return;

    // Get component heights for reference
    const fromHeight = this.getComponentHeight(this.fromComponent!);
    const toHeight = this.getComponentHeight(this.toComponent!);

    // Calculate elevations based on port positions
    const fromElevation = this.getPortElevation(this.fromComponent!, this.fromPort!, fromHeight);
    const toElevation = this.getPortElevation(this.toComponent!, this.toPort!, toHeight);

    // Calculate minimum length based on actual 3D port positions (including elevation)
    const fromPortX = this.fromComponent!.position.x + this.fromPort!.position.x;
    const fromPortY = this.fromComponent!.position.y + this.fromPort!.position.y;
    const toPortX = this.toComponent!.position.x + this.toPort!.position.x;
    const toPortY = this.toComponent!.position.y + this.toPort!.position.y;

    // Get component base elevations
    const fromComponentElev = (this.fromComponent! as any).elevation ?? 0;
    const toComponentElev = (this.toComponent! as any).elevation ?? 0;

    // Calculate absolute elevations of each port
    const fromAbsoluteElev = fromComponentElev + fromElevation;
    const toAbsoluteElev = toComponentElev + toElevation;

    // Calculate 3D distance including elevation difference
    const dx = toPortX - fromPortX;
    const dy = toPortY - fromPortY;
    const dz = toAbsoluteElev - fromAbsoluteElev;
    const portDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Check if components are in a contained relationship:
    // 1. One is directly contained by the other (parent-child)
    // 2. Both are contained by the same parent (siblings inside same vessel)
    // In either case the connection is a wall opening rather than a run of pipe -
    // BUT only when the ports are actually close. A component sitting inside a
    // big containment building is "contained" yet may be 30 m from its sibling;
    // that must be a real (piped) connection, not a <=1 m opening. Gate the
    // internal classification on physical proximity.
    const fromContainedBy = this.fromComponent!.containedBy;
    const toContainedBy = this.toComponent!.containedBy;
    const INTERNAL_MAX_PORT_DISTANCE = 2.0; // m - openings are through a shared wall
    const containedRelationship =
      fromContainedBy === this.toComponent!.id ||
      toContainedBy === this.fromComponent!.id ||
      (fromContainedBy !== undefined && fromContainedBy === toContainedBy);
    const isContainedConnection = containedRelationship && portDistance <= INTERNAL_MAX_PORT_DISTANCE;
    if (containedRelationship && !isContainedConnection) {
      console.log(`[Connect] contained pair but ports are ${portDistance.toFixed(1)} m apart ` +
        `(> ${INTERNAL_MAX_PORT_DISTANCE} m) - treating as a piped connection, not an internal opening`);
    }

    // For contained connections, min is 0.1m (wall opening), max is 1m
    // For regular connections, min is the actual 3D distance between ports
    const minLength = isContainedConnection ? 0.1 : portDistance;
    const maxLength = isContainedConnection ? 1.0 : 1000;

    // Component info section
    const infoSection = document.createElement('div');
    infoSection.style.cssText = 'background: #2a2e38; padding: 10px; border-radius: 4px; margin-bottom: 15px;';

    // Show different info for contained connections
    const elevDiff = Math.abs(toAbsoluteElev - fromAbsoluteElev);
    const isSiblingConnection = fromContainedBy !== undefined && fromContainedBy === toContainedBy;
    const containedNote = isContainedConnection
      ? `<div style="margin-top: 8px; padding: 6px; background: #1a3a2a; border-radius: 4px; font-size: 11px; color: #6c8;">
           <strong>Internal Connection:</strong> ${isSiblingConnection
             ? 'Components share the same container (e.g., core/annulus regions).'
             : 'Direct opening between component and container.'} Max 1m length.
         </div>`
      : `<div style="margin-top: 8px; font-size: 11px; color: #667788;">
           Port-to-port 3D distance: ${portDistance.toFixed(1)} m (elevation diff: ${elevDiff.toFixed(1)} m)
         </div>`;

    infoSection.innerHTML = `
      <div style="font-size: 12px; color: #7af; margin-bottom: 8px;">Component Information</div>
      <div style="display: flex; justify-content: space-between; font-size: 11px;">
        <div>
          <div style="color: #99aacc;">From: ${this.fromComponent!.label || this.fromComponent!.id}</div>
          <div style="color: #667788;">Height: ${fromHeight.toFixed(1)} m</div>
          <div style="color: #667788;">Port: ${this.fromPort!.id}</div>
        </div>
        <div>
          <div style="color: #99aacc;">To: ${this.toComponent!.label || this.toComponent!.id}</div>
          <div style="color: #667788;">Height: ${toHeight.toFixed(1)} m</div>
          <div style="color: #667788;">Port: ${this.toPort!.id}</div>
        </div>
      </div>
      ${containedNote}
    `;
    this.bodyElement.appendChild(infoSection);

    // Helper to calculate 3D distance based on current elevation values
    const calculate3DDistance = (fromRelElev: number, toRelElev: number): number => {
      const fromAbsElev = fromComponentElev + fromRelElev;
      const toAbsElev = toComponentElev + toRelElev;
      const dz = toAbsElev - fromAbsElev;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    // Create from-elevation field with absolute elevation display
    const roundElev = (v: number) => Math.round(v * 1000) / 1000;
    const fromElevGroup = document.createElement('div');
    fromElevGroup.className = 'form-group';
    const fromElevLabel = document.createElement('label');
    fromElevLabel.textContent = 'From Elevation (m)';
    fromElevLabel.setAttribute('for', 'from-elevation');
    fromElevGroup.appendChild(fromElevLabel);

    const fromElevInput = document.createElement('input');
    fromElevInput.type = 'number';
    fromElevInput.id = 'from-elevation';
    fromElevInput.value = String(roundElev(fromElevation));
    // The exact port elevation can sit slightly outside [0, height]
    // (e.g. a pump suction flange below the bounding box) - widen the
    // allowed range so the default value is always valid
    fromElevInput.min = String(Math.min(0, roundElev(fromElevation)));
    fromElevInput.max = String(Math.max(fromHeight, roundElev(fromElevation)));
    fromElevInput.step = '0.1';
    const fromIsPinned = hasPinnedPortElevations(this.fromComponent!);
    if (fromIsPinned) {
      fromElevInput.readOnly = true;
      fromElevInput.title = `${this.fromComponent!.type === 'pump' ? 'Pump nozzle' : 'Valve port'} elevations are fixed by the component geometry and follow it automatically`;
    }
    fromElevGroup.appendChild(fromElevInput);

    const fromElevHelp = document.createElement('div');
    fromElevHelp.className = 'help-text';
    fromElevHelp.id = 'from-elevation-help';
    fromElevHelp.textContent = fromIsPinned
      ? `Fixed at the ${this.fromComponent!.type === 'pump' ? 'pump nozzle' : 'valve port'} | Absolute: ${(fromComponentElev + fromElevation).toFixed(1)} m`
      : `Relative: 0 to ${fromHeight.toFixed(1)} m | Absolute: ${(fromComponentElev + fromElevation).toFixed(1)} m`;
    fromElevGroup.appendChild(fromElevHelp);
    this.bodyElement.appendChild(fromElevGroup);

    // Create to-elevation field with absolute elevation display
    const toElevGroup = document.createElement('div');
    toElevGroup.className = 'form-group';
    const toElevLabel = document.createElement('label');
    toElevLabel.textContent = 'To Elevation (m)';
    toElevLabel.setAttribute('for', 'to-elevation');
    toElevGroup.appendChild(toElevLabel);

    const toElevInput = document.createElement('input');
    toElevInput.type = 'number';
    toElevInput.id = 'to-elevation';
    toElevInput.value = String(roundElev(toElevation));
    toElevInput.min = String(Math.min(0, roundElev(toElevation)));
    toElevInput.max = String(Math.max(toHeight, roundElev(toElevation)));
    toElevInput.step = '0.1';
    const toIsPinned = hasPinnedPortElevations(this.toComponent!);
    if (toIsPinned) {
      toElevInput.readOnly = true;
      toElevInput.title = `${this.toComponent!.type === 'pump' ? 'Pump nozzle' : 'Valve port'} elevations are fixed by the component geometry and follow it automatically`;
    }
    toElevGroup.appendChild(toElevInput);

    const toElevHelp = document.createElement('div');
    toElevHelp.className = 'help-text';
    toElevHelp.id = 'to-elevation-help';
    toElevHelp.textContent = toIsPinned
      ? `Fixed at the ${this.toComponent!.type === 'pump' ? 'pump nozzle' : 'valve port'} | Absolute: ${(toComponentElev + toElevation).toFixed(1)} m`
      : `Relative: 0 to ${toHeight.toFixed(1)} m | Absolute: ${(toComponentElev + toElevation).toFixed(1)} m`;
    toElevGroup.appendChild(toElevHelp);
    this.bodyElement.appendChild(toElevGroup);

    // Line spec selector - standardized pipe diameters & pressure ratings.
    // Contained connections are wall openings, not runs of pipe, so they
    // keep the freeform flow area instead.
    let specSelect: HTMLSelectElement | null = null;
    let specDesc: HTMLElement | null = null;
    let ratingGroup: HTMLElement | null = null;
    let ratingInput: HTMLInputElement | null = null;
    if (!isContainedConnection) {
      const specGroup = document.createElement('div');
      specGroup.className = 'form-group';
      const specLabel = document.createElement('label');
      specLabel.textContent = 'Line Specification';
      specLabel.setAttribute('for', 'pipe-spec');
      specGroup.appendChild(specLabel);

      specSelect = document.createElement('select');
      specSelect.id = 'pipe-spec';
      specSelect.title = 'Standardized line sizes with pressure ratings. Pick the service that matches this connection, or Custom to enter the flow area directly.';
      for (const spec of PIPE_SPECS) {
        const opt = document.createElement('option');
        opt.value = spec.id;
        opt.textContent = spec.label;
        if (spec.id === 'spec-10in') opt.selected = true; // same area as the old 0.05 m² default
        specSelect.appendChild(opt);
      }
      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = 'Custom — enter flow area and rating';
      specSelect.appendChild(customOpt);
      specGroup.appendChild(specSelect);

      specDesc = document.createElement('div');
      specDesc.className = 'help-text';
      specGroup.appendChild(specDesc);
      this.bodyElement.appendChild(specGroup);
    }

    // Diameter field - the friendlier way to size the line. Coupled to the
    // flow area below via A = π d²/4: editing either recalculates the other.
    const diameterGroup = document.createElement('div');
    diameterGroup.className = 'form-group';
    const diameterLabel = document.createElement('label');
    diameterLabel.textContent = 'Inner Diameter (m)';
    diameterLabel.setAttribute('for', 'connection-diameter');
    diameterGroup.appendChild(diameterLabel);

    const diameterInput = document.createElement('input');
    diameterInput.type = 'number';
    diameterInput.id = 'connection-diameter';
    diameterInput.title = 'Editing the diameter recalculates the flow area, and vice versa';
    diameterInput.value = '0.2523'; // same bore as the 0.05 m² default area
    diameterInput.min = '0.03';
    diameterInput.max = '3.6';
    diameterInput.step = '0.005';
    diameterGroup.appendChild(diameterInput);

    const diameterHelp = document.createElement('div');
    diameterHelp.className = 'help-text';
    diameterHelp.textContent = 'Coupled to the flow area below (A = π d²/4)';
    diameterGroup.appendChild(diameterHelp);
    this.bodyElement.appendChild(diameterGroup);

    // Create flow area field
    const flowAreaGroup = document.createElement('div');
    flowAreaGroup.className = 'form-group';
    const flowAreaLabel = document.createElement('label');
    flowAreaLabel.textContent = 'Flow Area (m²)';
    flowAreaLabel.setAttribute('for', 'flow-area');
    flowAreaGroup.appendChild(flowAreaLabel);

    const flowAreaInput = document.createElement('input');
    flowAreaInput.type = 'number';
    flowAreaInput.id = 'flow-area';
    flowAreaInput.value = '0.05';
    flowAreaInput.min = '0.001';
    flowAreaInput.max = '10';
    flowAreaInput.step = '0.001';
    flowAreaGroup.appendChild(flowAreaInput);

    const flowAreaHelp = document.createElement('div');
    flowAreaHelp.className = 'help-text';
    flowAreaHelp.textContent = 'Cross-sectional area of connection';
    flowAreaGroup.appendChild(flowAreaHelp);
    this.bodyElement.appendChild(flowAreaGroup);

    // Pressure rating field - only shown for the Custom line spec (standard
    // specs carry their own rating)
    if (!isContainedConnection) {
      ratingGroup = document.createElement('div');
      ratingGroup.className = 'form-group';
      const ratingLabel = document.createElement('label');
      ratingLabel.textContent = 'Pressure Rating (bar)';
      ratingLabel.setAttribute('for', 'pipe-pressure-rating');
      ratingGroup.appendChild(ratingLabel);

      ratingInput = document.createElement('input');
      ratingInput.type = 'number';
      ratingInput.id = 'pipe-pressure-rating';
      ratingInput.value = '155';
      ratingInput.min = '1';
      ratingInput.max = '600';
      ratingInput.step = '5';
      ratingGroup.appendChild(ratingInput);

      const ratingHelp = document.createElement('div');
      ratingHelp.className = 'help-text';
      ratingHelp.textContent = 'Design pressure of the pipe created for this connection - its burst point and cost follow this rating';
      ratingGroup.appendChild(ratingHelp);
      this.bodyElement.appendChild(ratingGroup);
    }

    // Create length field
    const lengthGroup = document.createElement('div');
    lengthGroup.className = 'form-group';
    const lengthLabel = document.createElement('label');
    lengthLabel.textContent = (isContainedConnection ? 'Opening Flow-Path Length' : 'Connection Length') + ' (m)';
    lengthLabel.setAttribute('for', 'length');
    lengthGroup.appendChild(lengthLabel);

    const lengthInput = document.createElement('input');
    lengthInput.type = 'number';
    lengthInput.id = 'length';
    lengthInput.value = String(isContainedConnection ? 0.5 : Math.max(minLength, 2));
    lengthInput.min = String(minLength);
    lengthInput.max = String(maxLength);
    lengthInput.step = '0.1';
    lengthGroup.appendChild(lengthInput);

    const lengthHelp = document.createElement('div');
    lengthHelp.className = 'help-text';
    lengthHelp.id = 'length-help';
    lengthHelp.textContent = isContainedConnection
      ? 'Distance the fluid travels through the shared wall/opening between these two regions. Short (≤1 m) - it sets the flow inertia and friction of the internal port, not a length of external pipe.'
      : `Min: ${minLength.toFixed(1)} m (3D port distance)`;
    lengthGroup.appendChild(lengthHelp);
    this.bodyElement.appendChild(lengthGroup);

    // Track the current minimum length so we can detect when user has length set to minimum
    let currentMinLength = minLength;

    // Update function for when elevations change
    const updateLengthConstraints = () => {
      const fromRelElev = parseFloat(fromElevInput.value) || 0;
      const toRelElev = parseFloat(toElevInput.value) || 0;

      // Update absolute elevation displays
      const fromAbsElev = fromComponentElev + fromRelElev;
      const toAbsElev = toComponentElev + toRelElev;
      fromElevHelp.textContent = `Relative: 0 to ${fromHeight.toFixed(1)} m | Absolute: ${fromAbsElev.toFixed(1)} m`;
      toElevHelp.textContent = `Relative: 0 to ${toHeight.toFixed(1)} m | Absolute: ${toAbsElev.toFixed(1)} m`;

      if (!isContainedConnection) {
        // Recalculate minimum length based on new 3D distance
        const newMinLength = calculate3DDistance(fromRelElev, toRelElev);

        // Check if current length was at the previous minimum (within tolerance)
        const currentLength = parseFloat(lengthInput.value) || 0;
        const wasAtMinimum = Math.abs(currentLength - currentMinLength) < 0.05;

        // Update minimum
        lengthInput.min = String(newMinLength);
        lengthHelp.textContent = `Min: ${newMinLength.toFixed(1)} m (3D port distance)`;

        // If length was at previous minimum, or is now below new minimum, update to new minimum
        if (wasAtMinimum || currentLength < newMinLength) {
          lengthInput.value = String(Math.max(newMinLength, 2));
        }

        // Track the new minimum for next update
        currentMinLength = newMinLength;
      }
    };

    // Add event listeners for elevation changes
    fromElevInput.addEventListener('input', updateLengthConstraints);
    toElevInput.addEventListener('input', updateLengthConstraints);

    // Add auto-pipe creation note
    const pipeNote = document.createElement('div');
    pipeNote.style.cssText = 'margin-top: 15px; padding: 10px; background: #252830; border-radius: 4px; border-left: 3px solid #5588cc;';
    pipeNote.innerHTML = `
      <div style="font-size: 12px; color: #7af; margin-bottom: 5px;">Automatic Pipe Creation</div>
      <div id="pipe-status" style="font-size: 11px; color: #99aacc;">
        Pipes are automatically created for connections with flow area > 0.1 m² and length > 1 m
      </div>
    `;
    this.bodyElement.appendChild(pipeNote);

    // Update pipe status when inputs change
    const pipeStatus = document.getElementById('pipe-status')!;

    const updatePipeStatus = () => {
      const area = parseFloat(flowAreaInput.value);
      const length = parseFloat(lengthInput.value);
      const willCreatePipe = area > 0.1 && length > 1;

      if (willCreatePipe) {
        const diameter = Math.sqrt(area * 4 / Math.PI);
        const rating = ratingInput ? parseFloat(ratingInput.value) : NaN;
        const ratingNote = Number.isFinite(rating) ? `, rated ${rating} bar` : '';
        pipeStatus.innerHTML = `✓ A pipe will be created (diameter: ${diameter.toFixed(3)} m${ratingNote})`;
        pipeStatus.style.color = '#4a4';
      } else {
        pipeStatus.innerHTML = 'Direct connection (no pipe needed)';
        pipeStatus.style.color = '#99aacc';
      }
    };

    flowAreaInput.addEventListener('input', updatePipeStatus);
    lengthInput.addEventListener('input', updatePipeStatus);

    // Bidirectional diameter <-> flow area coupling (A = π d²/4)
    const syncDiameterFromArea = () => {
      const area = parseFloat(flowAreaInput.value);
      if (area > 0) diameterInput.value = String(+Math.sqrt(4 * area / Math.PI).toPrecision(4));
    };
    let areaDiameterSyncing = false;
    diameterInput.addEventListener('input', () => {
      if (areaDiameterSyncing) return;
      const d = parseFloat(diameterInput.value);
      if (d > 0) {
        areaDiameterSyncing = true;
        flowAreaInput.value = String(+(Math.PI * d * d / 4).toPrecision(4));
        flowAreaInput.dispatchEvent(new Event('input')); // pipe status etc.
        areaDiameterSyncing = false;
      }
    });
    flowAreaInput.addEventListener('input', () => {
      if (!areaDiameterSyncing) syncDiameterFromArea();
    });

    // Apply the selected line spec: fill in the diameter/flow area and
    // rating, and only allow direct edits when Custom is selected
    const applySpec = () => {
      if (!specSelect) return;
      const spec = PIPE_SPECS.find(s => s.id === specSelect!.value);
      if (spec) {
        flowAreaInput.value = pipeSpecFlowArea(spec).toFixed(4);
        flowAreaInput.readOnly = true;
        diameterInput.readOnly = true;
        flowAreaHelp.textContent = `Set by the line spec (${spec.diameter} m inner diameter)`;
        diameterHelp.textContent = 'Set by the line spec';
        if (ratingInput) ratingInput.value = String(spec.pressureRating);
        if (ratingGroup) ratingGroup.style.display = 'none';
        if (specDesc) specDesc.textContent = `${spec.description}`;
      } else {
        flowAreaInput.readOnly = false;
        diameterInput.readOnly = false;
        flowAreaHelp.textContent = 'Cross-sectional area of connection';
        diameterHelp.textContent = 'Coupled to the flow area below (A = π d²/4)';
        if (ratingGroup) ratingGroup.style.display = '';
        if (specDesc) specDesc.textContent = 'Custom line - set the diameter (or flow area) and pressure rating yourself.';
      }
      syncDiameterFromArea();
      updatePipeStatus();
    };
    if (specSelect) {
      specSelect.addEventListener('change', applySpec);
      applySpec();
    } else {
      updatePipeStatus();
    }
  }

  private getComponentHeight(component: PlantComponent): number {
    // Must match the renderer's height convention — see getComponentVisualHeight
    return getComponentVisualHeight(component);
  }

  private getPortElevation(_component: PlantComponent, port: Port, componentHeight: number): number {
    // Exact elevation of the drawn port above the component bottom.
    // This is the same formula the renderer uses to anchor connection
    // endpoints, so defaulting to it puts the connection line exactly on
    // the drawn nozzle. (Can be negative for ports drawn below the
    // component's bounding box, e.g. a pump's suction flange.)
    return componentHeight / 2 - port.position.y;
  }

  private handleConfirm() {
    const fromElevation = parseFloat((document.getElementById('from-elevation') as HTMLInputElement).value);
    const toElevation = parseFloat((document.getElementById('to-elevation') as HTMLInputElement).value);
    const flowArea = parseFloat((document.getElementById('flow-area') as HTMLInputElement).value);
    const length = parseFloat((document.getElementById('length') as HTMLInputElement).value);

    this.dialog.style.display = 'none';

    if (this.isEditMode) {
      // Edit mode - return just the edited values. Opening heights: empty
      // or 0 means "point sample" and is stored as undefined.
      const parseOpening = (id: string): number | undefined => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) && v > 0 ? v : undefined;
      };
      if (this.currentEditCallback) {
        this.currentEditCallback({
          fromElevation,
          toElevation,
          flowArea,
          length,
          fromOpeningHeight: parseOpening('from-opening-height'),
          toOpeningHeight: parseOpening('to-opening-height')
        });
        this.currentEditCallback = null;
      }
    } else {
      // Create mode - return full config
      if (!this.fromComponent || !this.toComponent || !this.fromPort || !this.toPort) return;

      // Pressure rating for the auto-created pipe: from the selected line
      // spec, or the rating field when Custom is selected. Contained
      // connections have no spec selector and get no rating override.
      let pressureRating: number | undefined;
      const specSel = document.getElementById('pipe-spec') as HTMLSelectElement | null;
      if (specSel) {
        const spec = PIPE_SPECS.find(s => s.id === specSel.value);
        if (spec) {
          pressureRating = spec.pressureRating;
        } else {
          const ratingEl = document.getElementById('pipe-pressure-rating') as HTMLInputElement | null;
          const v = ratingEl ? parseFloat(ratingEl.value) : NaN;
          if (Number.isFinite(v)) pressureRating = v;
        }
      }

      const config: ConnectionConfig = {
        fromComponent: this.fromComponent,
        toComponent: this.toComponent,
        fromPort: this.fromPort,
        toPort: this.toPort,
        fromElevation,
        toElevation,
        flowArea,
        length,
        createPipe: flowArea > 0.1 && length > 1,
        pressureRating
      };

      if (this.currentCallback) {
        this.currentCallback(config);
        this.currentCallback = null;
      }
    }

    this.isEditMode = false;
  }

  private handleCancel() {
    this.dialog.style.display = 'none';

    if (this.isEditMode) {
      if (this.currentEditCallback) {
        this.currentEditCallback(null);
        this.currentEditCallback = null;
      }
    } else {
      if (this.currentCallback) {
        this.currentCallback(null);
        this.currentCallback = null;
      }
    }

    this.isEditMode = false;
  }

  /**
   * Show the dialog in edit mode for an existing connection
   */
  edit(
    connection: Connection,
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    callback: (result: ConnectionEditResult | null) => void
  ) {
    this.isEditMode = true;
    this.currentEditCallback = callback;
    this.fromComponent = fromComponent;
    this.toComponent = toComponent;

    // Set title
    const fromName = fromComponent.label || fromComponent.id;
    const toName = toComponent.label || toComponent.id;
    this.titleElement.textContent = `Edit Connection: ${fromName} → ${toName}`;
    this.confirmButton.textContent = 'Save Changes';

    // Build edit form
    this.buildEditForm(connection, fromComponent, toComponent);

    // Show dialog
    this.dialog.style.display = 'flex';

    // Focus first input
    const firstInput = this.bodyElement.querySelector('input') as HTMLElement;
    if (firstInput) {
      firstInput.focus();
    }
  }

  private buildEditForm(connection: Connection, fromComponent: PlantComponent, toComponent: PlantComponent) {
    this.bodyElement.innerHTML = '';

    // Get component heights for validation
    const fromHeight = this.getComponentHeight(fromComponent);
    const toHeight = this.getComponentHeight(toComponent);

    // Get component base elevations
    const fromComponentElev = (fromComponent as any).elevation ?? 0;
    const toComponentElev = (toComponent as any).elevation ?? 0;

    // Current values
    const currentFromElev = connection.fromElevation ?? 0;
    const currentToElev = connection.toElevation ?? 0;
    const currentFlowArea = connection.flowArea ?? 0.05;
    const currentLength = connection.length ?? 2;

    // Component info section
    const infoSection = document.createElement('div');
    infoSection.style.cssText = 'background: #2a2e38; padding: 10px; border-radius: 4px; margin-bottom: 15px;';
    infoSection.innerHTML = `
      <div style="font-size: 12px; color: #7af; margin-bottom: 8px;">Connection Information</div>
      <div style="display: flex; justify-content: space-between; font-size: 11px;">
        <div>
          <div style="color: #99aacc;">From: ${fromComponent.label || fromComponent.id}</div>
          <div style="color: #667788;">Component height: ${fromHeight.toFixed(1)} m</div>
          <div style="color: #667788;">Base elevation: ${fromComponentElev.toFixed(1)} m</div>
        </div>
        <div>
          <div style="color: #99aacc;">To: ${toComponent.label || toComponent.id}</div>
          <div style="color: #667788;">Component height: ${toHeight.toFixed(1)} m</div>
          <div style="color: #667788;">Base elevation: ${toComponentElev.toFixed(1)} m</div>
        </div>
      </div>
    `;
    this.bodyElement.appendChild(infoSection);

    // From elevation field
    const fromElevGroup = document.createElement('div');
    fromElevGroup.className = 'form-group';
    const fromElevLabel = document.createElement('label');
    fromElevLabel.textContent = 'From Elevation (m)';
    fromElevLabel.setAttribute('for', 'from-elevation');
    fromElevGroup.appendChild(fromElevLabel);

    const fromElevInput = document.createElement('input');
    fromElevInput.type = 'number';
    fromElevInput.id = 'from-elevation';
    fromElevInput.value = String(currentFromElev);
    // Widen the range so stored values slightly outside [0, height]
    // (e.g. a pump suction flange below the bounding box) remain valid
    fromElevInput.min = String(Math.min(0, currentFromElev));
    fromElevInput.max = String(Math.max(fromHeight, currentFromElev));
    fromElevInput.step = '0.1';
    const fromIsPinned = hasPinnedPortElevations(fromComponent);
    if (fromIsPinned) {
      fromElevInput.readOnly = true;
      fromElevInput.title = `${fromComponent.type === 'pump' ? 'Pump nozzle' : 'Valve port'} elevations are fixed by the component geometry and follow it automatically`;
    }
    fromElevGroup.appendChild(fromElevInput);

    const fromElevHelp = document.createElement('div');
    fromElevHelp.className = 'help-text';
    const fromElevHelpText = (relElev: number) => fromIsPinned
      ? `Fixed at the ${fromComponent.type === 'pump' ? 'pump nozzle' : 'valve port'} | Absolute: ${(fromComponentElev + relElev).toFixed(1)} m`
      : `Relative: 0 to ${fromHeight.toFixed(1)} m | Absolute: ${(fromComponentElev + relElev).toFixed(1)} m`;
    fromElevHelp.textContent = fromElevHelpText(currentFromElev);
    fromElevGroup.appendChild(fromElevHelp);
    this.bodyElement.appendChild(fromElevGroup);

    // From opening height - how tall the offtake aperture is (draws average
    // the phase profile over it; see drawCompositionAt)
    const fromOpenGroup = document.createElement('div');
    fromOpenGroup.className = 'form-group';
    const fromOpenLabel = document.createElement('label');
    fromOpenLabel.textContent = 'From Opening Height (m, 0 = point)';
    fromOpenLabel.setAttribute('for', 'from-opening-height');
    fromOpenLabel.title = OPENING_HEIGHT_TIP;
    fromOpenGroup.appendChild(fromOpenLabel);
    const fromOpenInput = document.createElement('input');
    fromOpenInput.type = 'number';
    fromOpenInput.id = 'from-opening-height';
    fromOpenInput.value = connection.fromOpeningHeight ? String(connection.fromOpeningHeight) : '';
    fromOpenInput.placeholder = 'point sample';
    fromOpenInput.min = '0';
    fromOpenInput.step = '0.1';
    fromOpenInput.title = OPENING_HEIGHT_TIP;
    fromOpenGroup.appendChild(fromOpenInput);
    this.bodyElement.appendChild(fromOpenGroup);

    // To elevation field
    const toElevGroup = document.createElement('div');
    toElevGroup.className = 'form-group';
    const toElevLabel = document.createElement('label');
    toElevLabel.textContent = 'To Elevation (m)';
    toElevLabel.setAttribute('for', 'to-elevation');
    toElevGroup.appendChild(toElevLabel);

    const toElevInput = document.createElement('input');
    toElevInput.type = 'number';
    toElevInput.id = 'to-elevation';
    toElevInput.value = String(currentToElev);
    toElevInput.min = String(Math.min(0, currentToElev));
    toElevInput.max = String(Math.max(toHeight, currentToElev));
    toElevInput.step = '0.1';
    const toIsPinned = hasPinnedPortElevations(toComponent);
    if (toIsPinned) {
      toElevInput.readOnly = true;
      toElevInput.title = `${toComponent.type === 'pump' ? 'Pump nozzle' : 'Valve port'} elevations are fixed by the component geometry and follow it automatically`;
    }
    toElevGroup.appendChild(toElevInput);

    const toElevHelp = document.createElement('div');
    toElevHelp.className = 'help-text';
    const toElevHelpText = (relElev: number) => toIsPinned
      ? `Fixed at the ${toComponent.type === 'pump' ? 'pump nozzle' : 'valve port'} | Absolute: ${(toComponentElev + relElev).toFixed(1)} m`
      : `Relative: 0 to ${toHeight.toFixed(1)} m | Absolute: ${(toComponentElev + relElev).toFixed(1)} m`;
    toElevHelp.textContent = toElevHelpText(currentToElev);
    toElevGroup.appendChild(toElevHelp);
    this.bodyElement.appendChild(toElevGroup);

    // To opening height
    const toOpenGroup = document.createElement('div');
    toOpenGroup.className = 'form-group';
    const toOpenLabel = document.createElement('label');
    toOpenLabel.textContent = 'To Opening Height (m, 0 = point)';
    toOpenLabel.setAttribute('for', 'to-opening-height');
    toOpenLabel.title = OPENING_HEIGHT_TIP;
    toOpenGroup.appendChild(toOpenLabel);
    const toOpenInput = document.createElement('input');
    toOpenInput.type = 'number';
    toOpenInput.id = 'to-opening-height';
    toOpenInput.value = connection.toOpeningHeight ? String(connection.toOpeningHeight) : '';
    toOpenInput.placeholder = 'point sample';
    toOpenInput.min = '0';
    toOpenInput.step = '0.1';
    toOpenInput.title = OPENING_HEIGHT_TIP;
    toOpenGroup.appendChild(toOpenInput);
    this.bodyElement.appendChild(toOpenGroup);

    // Update absolute elevation displays when inputs change
    fromElevInput.addEventListener('input', () => {
      const fromRelElev = parseFloat(fromElevInput.value) || 0;
      fromElevHelp.textContent = fromElevHelpText(fromRelElev);
    });
    toElevInput.addEventListener('input', () => {
      const toRelElev = parseFloat(toElevInput.value) || 0;
      toElevHelp.textContent = toElevHelpText(toRelElev);
    });

    // Line spec quick-fill: picking a standard size fills the flow area below.
    // (The pressure rating of an already-created pipe is edited on the pipe
    // component itself, so the spec here only drives the area.)
    const specGroup = document.createElement('div');
    specGroup.className = 'form-group';
    const specLabel = document.createElement('label');
    specLabel.textContent = 'Line Specification';
    specLabel.setAttribute('for', 'pipe-spec-edit');
    specGroup.appendChild(specLabel);

    const specSelect = document.createElement('select');
    specSelect.id = 'pipe-spec-edit';
    specSelect.title = 'Standardized line sizes. Picking one sets the flow area; edit the pipe component itself to change an existing pipe\'s pressure rating.';
    const matchedSpec = findMatchingPipeSpec(currentFlowArea);
    for (const spec of PIPE_SPECS) {
      const opt = document.createElement('option');
      opt.value = spec.id;
      opt.textContent = spec.label;
      if (matchedSpec && spec.id === matchedSpec.id) opt.selected = true;
      specSelect.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom — enter flow area directly';
    if (!matchedSpec) customOpt.selected = true;
    specSelect.appendChild(customOpt);
    specGroup.appendChild(specSelect);

    const specDesc = document.createElement('div');
    specDesc.className = 'help-text';
    specDesc.textContent = matchedSpec ? matchedSpec.description : '';
    specGroup.appendChild(specDesc);
    this.bodyElement.appendChild(specGroup);

    // Diameter field - coupled to the flow area below (A = π d²/4)
    const equivDiameter = (area: number) => Math.sqrt(Math.max(area, 0) * 4 / Math.PI);
    const diameterGroup = document.createElement('div');
    diameterGroup.className = 'form-group';
    const diameterLabel = document.createElement('label');
    diameterLabel.textContent = 'Inner Diameter (m)';
    diameterLabel.setAttribute('for', 'connection-diameter');
    diameterGroup.appendChild(diameterLabel);

    const diameterInput = document.createElement('input');
    diameterInput.type = 'number';
    diameterInput.id = 'connection-diameter';
    diameterInput.title = 'Editing the diameter recalculates the flow area, and vice versa';
    diameterInput.value = String(+equivDiameter(currentFlowArea).toPrecision(4));
    diameterInput.min = '0.03';
    diameterInput.max = '3.6';
    diameterInput.step = '0.005';
    diameterGroup.appendChild(diameterInput);

    const diameterHelp = document.createElement('div');
    diameterHelp.className = 'help-text';
    diameterHelp.textContent = 'Coupled to the flow area below (A = π d²/4)';
    diameterGroup.appendChild(diameterHelp);
    this.bodyElement.appendChild(diameterGroup);

    // Flow area field
    const flowAreaGroup = document.createElement('div');
    flowAreaGroup.className = 'form-group';
    const flowAreaLabel = document.createElement('label');
    flowAreaLabel.textContent = 'Flow Area (m²)';
    flowAreaLabel.setAttribute('for', 'flow-area');
    flowAreaGroup.appendChild(flowAreaLabel);

    const flowAreaInput = document.createElement('input');
    flowAreaInput.type = 'number';
    flowAreaInput.id = 'flow-area';
    flowAreaInput.value = String(currentFlowArea);
    flowAreaInput.min = '0.001';
    flowAreaInput.max = '10';
    flowAreaInput.step = '0.001';
    flowAreaGroup.appendChild(flowAreaInput);

    const flowAreaHelp = document.createElement('div');
    flowAreaHelp.className = 'help-text';
    flowAreaHelp.textContent = 'Cross-sectional area of connection';
    flowAreaGroup.appendChild(flowAreaHelp);
    this.bodyElement.appendChild(flowAreaGroup);

    // A manual edit of either coupled field means the value no longer comes
    // from the selected spec - keep the pair and the spec dropdown in sync
    const syncSpecFromArea = (area: number) => {
      const stillMatches = findMatchingPipeSpec(area);
      specSelect.value = stillMatches ? stillMatches.id : 'custom';
      specDesc.textContent = stillMatches ? stillMatches.description : '';
    };
    let areaDiameterSyncing = false;
    flowAreaInput.addEventListener('input', () => {
      const area = parseFloat(flowAreaInput.value) || 0;
      if (!areaDiameterSyncing && area > 0) {
        diameterInput.value = String(+equivDiameter(area).toPrecision(4));
      }
      syncSpecFromArea(area);
    });
    diameterInput.addEventListener('input', () => {
      const d = parseFloat(diameterInput.value);
      if (d > 0) {
        areaDiameterSyncing = true;
        flowAreaInput.value = String(+(Math.PI * d * d / 4).toPrecision(4));
        flowAreaInput.dispatchEvent(new Event('input'));
        areaDiameterSyncing = false;
      }
    });

    // Picking a spec fills the diameter and flow area
    specSelect.addEventListener('change', () => {
      const spec = PIPE_SPECS.find(s => s.id === specSelect.value);
      specDesc.textContent = spec ? spec.description : '';
      if (spec) {
        flowAreaInput.value = pipeSpecFlowArea(spec).toFixed(4);
        diameterInput.value = String(+equivDiameter(pipeSpecFlowArea(spec)).toPrecision(4));
      }
    });

    // Length field
    const lengthGroup = document.createElement('div');
    lengthGroup.className = 'form-group';
    const lengthLabel = document.createElement('label');
    lengthLabel.textContent = 'Connection Length (m)';
    lengthLabel.setAttribute('for', 'length');
    lengthGroup.appendChild(lengthLabel);

    const lengthInput = document.createElement('input');
    lengthInput.type = 'number';
    lengthInput.id = 'length';
    lengthInput.value = String(currentLength);
    lengthInput.min = '0.1';
    lengthInput.max = '1000';
    lengthInput.step = '0.1';
    lengthGroup.appendChild(lengthInput);

    const lengthHelp = document.createElement('div');
    lengthHelp.className = 'help-text';
    lengthHelp.textContent = 'Physical length of the connection';
    lengthGroup.appendChild(lengthHelp);
    this.bodyElement.appendChild(lengthGroup);
  }
}