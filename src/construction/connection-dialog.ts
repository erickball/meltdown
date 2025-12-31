// Connection configuration dialog for creating connections between components

import { PlantComponent, Port } from '../types';

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
}

export class ConnectionDialog {
  private dialog: HTMLElement;
  private titleElement: HTMLElement;
  private bodyElement: HTMLElement;
  private confirmButton: HTMLElement;
  private cancelButton: HTMLElement;
  private closeButton: HTMLElement;
  private currentCallback: ((config: ConnectionConfig | null) => void) | null = null;
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

    // Close on background click
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) {
        this.handleCancel();
      }
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
    // In either case, the connection is just an opening - visual port positions don't reflect physical distance
    const fromContainedBy = this.fromComponent!.containedBy;
    const toContainedBy = this.toComponent!.containedBy;
    const isContainedConnection =
      fromContainedBy === this.toComponent!.id ||
      toContainedBy === this.fromComponent!.id ||
      (fromContainedBy !== undefined && fromContainedBy === toContainedBy);

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
    const fromElevGroup = document.createElement('div');
    fromElevGroup.className = 'form-group';
    const fromElevLabel = document.createElement('label');
    fromElevLabel.textContent = 'From Elevation (m)';
    fromElevLabel.setAttribute('for', 'from-elevation');
    fromElevGroup.appendChild(fromElevLabel);

    const fromElevInput = document.createElement('input');
    fromElevInput.type = 'number';
    fromElevInput.id = 'from-elevation';
    fromElevInput.value = String(fromElevation);
    fromElevInput.min = '0';
    fromElevInput.max = String(fromHeight);
    fromElevInput.step = '0.1';
    fromElevGroup.appendChild(fromElevInput);

    const fromElevHelp = document.createElement('div');
    fromElevHelp.className = 'help-text';
    fromElevHelp.id = 'from-elevation-help';
    fromElevHelp.textContent = `Relative: 0 to ${fromHeight.toFixed(1)} m | Absolute: ${(fromComponentElev + fromElevation).toFixed(1)} m`;
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
    toElevInput.value = String(toElevation);
    toElevInput.min = '0';
    toElevInput.max = String(toHeight);
    toElevInput.step = '0.1';
    toElevGroup.appendChild(toElevInput);

    const toElevHelp = document.createElement('div');
    toElevHelp.className = 'help-text';
    toElevHelp.id = 'to-elevation-help';
    toElevHelp.textContent = `Relative: 0 to ${toHeight.toFixed(1)} m | Absolute: ${(toComponentElev + toElevation).toFixed(1)} m`;
    toElevGroup.appendChild(toElevHelp);
    this.bodyElement.appendChild(toElevGroup);

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

    // Create length field
    const lengthGroup = document.createElement('div');
    lengthGroup.className = 'form-group';
    const lengthLabel = document.createElement('label');
    lengthLabel.textContent = (isContainedConnection ? 'Opening Thickness' : 'Connection Length') + ' (m)';
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
      ? 'Wall thickness of opening (max 1m for contained connections)'
      : `Min: ${minLength.toFixed(1)} m (3D port distance)`;
    lengthGroup.appendChild(lengthHelp);
    this.bodyElement.appendChild(lengthGroup);

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
        lengthInput.min = String(newMinLength);
        lengthHelp.textContent = `Min: ${newMinLength.toFixed(1)} m (3D port distance)`;

        // If current length is below new minimum, update it
        const currentLength = parseFloat(lengthInput.value) || 0;
        if (currentLength < newMinLength) {
          lengthInput.value = String(Math.max(newMinLength, 2));
        }
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
        pipeStatus.innerHTML = `✓ A pipe will be created (diameter: ${diameter.toFixed(3)} m)`;
        pipeStatus.style.color = '#4a4';
      } else {
        pipeStatus.innerHTML = 'Direct connection (no pipe needed)';
        pipeStatus.style.color = '#99aacc';
      }
    };

    flowAreaInput.addEventListener('input', updatePipeStatus);
    lengthInput.addEventListener('input', updatePipeStatus);
    updatePipeStatus();
  }

  private getComponentHeight(component: PlantComponent): number {
    // Get height based on component type
    if ('height' in component) {
      return component.height;
    }
    // Default heights for components without explicit height
    switch (component.type) {
      case 'pump': return 1;
      case 'valve': return 0.5;
      case 'pipe': return 0.3;
      default: return 2;
    }
  }

  private getPortElevation(_component: PlantComponent, port: Port, componentHeight: number): number {
    // Calculate elevation based on port position
    // Port positions are relative to component center
    const portY = port.position.y;

    // If port is at top (negative y), return full height
    if (portY < -componentHeight / 4) {
      return componentHeight;
    }
    // If port is at bottom (positive y), return 0
    else if (portY > componentHeight / 4) {
      return 0;
    }
    // Otherwise (side ports), return middle
    else {
      return componentHeight / 2;
    }
  }

  private handleConfirm() {
    if (!this.fromComponent || !this.toComponent || !this.fromPort || !this.toPort) return;

    const fromElevation = parseFloat((document.getElementById('from-elevation') as HTMLInputElement).value);
    const toElevation = parseFloat((document.getElementById('to-elevation') as HTMLInputElement).value);
    const flowArea = parseFloat((document.getElementById('flow-area') as HTMLInputElement).value);
    const length = parseFloat((document.getElementById('length') as HTMLInputElement).value);

    const config: ConnectionConfig = {
      fromComponent: this.fromComponent,
      toComponent: this.toComponent,
      fromPort: this.fromPort,
      toPort: this.toPort,
      fromElevation,
      toElevation,
      flowArea,
      length,
      createPipe: flowArea > 0.1 && length > 1
    };

    this.dialog.style.display = 'none';

    if (this.currentCallback) {
      this.currentCallback(config);
      this.currentCallback = null;
    }
  }

  private handleCancel() {
    this.dialog.style.display = 'none';

    if (this.currentCallback) {
      this.currentCallback(null);
      this.currentCallback = null;
    }
  }
}