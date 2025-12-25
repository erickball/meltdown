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

    // Calculate minimum length based on actual port positions
    const fromPortX = this.fromComponent!.position.x + this.fromPort!.position.x;
    const fromPortY = this.fromComponent!.position.y + this.fromPort!.position.y;
    const toPortX = this.toComponent!.position.x + this.toPort!.position.x;
    const toPortY = this.toComponent!.position.y + this.toPort!.position.y;

    const dx = toPortX - fromPortX;
    const dy = toPortY - fromPortY;
    const minLength = Math.sqrt(dx * dx + dy * dy);

    // Component info section
    const infoSection = document.createElement('div');
    infoSection.style.cssText = 'background: #2a2e38; padding: 10px; border-radius: 4px; margin-bottom: 15px;';
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
      <div style="margin-top: 8px; font-size: 11px; color: #667788;">
        Port-to-port distance: ${minLength.toFixed(1)} m
      </div>
    `;
    this.bodyElement.appendChild(infoSection);

    // Create form fields
    const fields = [
      {
        id: 'from-elevation',
        label: 'From Elevation',
        type: 'number',
        default: fromElevation,
        min: 0,
        max: fromHeight,
        step: 0.1,
        unit: 'm',
        help: `Height above component bottom (0 to ${fromHeight.toFixed(1)} m)`
      },
      {
        id: 'to-elevation',
        label: 'To Elevation',
        type: 'number',
        default: toElevation,
        min: 0,
        max: toHeight,
        step: 0.1,
        unit: 'm',
        help: `Height above component bottom (0 to ${toHeight.toFixed(1)} m)`
      },
      {
        id: 'flow-area',
        label: 'Flow Area',
        type: 'number',
        default: 0.05,
        min: 0.001,
        max: 10,
        step: 0.001,
        unit: 'm²',
        help: 'Cross-sectional area of connection'
      },
      {
        id: 'length',
        label: 'Connection Length',
        type: 'number',
        default: Math.max(minLength, 2),
        min: minLength,
        max: 1000,
        step: 0.1,
        unit: 'm',
        help: `Must be at least ${minLength.toFixed(1)} m`
      }
    ];

    fields.forEach(field => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';

      const label = document.createElement('label');
      label.textContent = field.label + (field.unit ? ` (${field.unit})` : '');
      label.setAttribute('for', field.id);
      formGroup.appendChild(label);

      const input = document.createElement('input');
      input.type = field.type;
      input.id = field.id;
      input.value = String(field.default);
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      formGroup.appendChild(input);

      if (field.help) {
        const helpText = document.createElement('div');
        helpText.className = 'help-text';
        helpText.textContent = field.help;
        formGroup.appendChild(helpText);
      }

      this.bodyElement.appendChild(formGroup);
    });

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
    const flowAreaInput = document.getElementById('flow-area') as HTMLInputElement;
    const lengthInput = document.getElementById('length') as HTMLInputElement;
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