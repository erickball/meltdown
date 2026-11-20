/**
 * Glue between PlantCanvas and the three.js 3D view.
 *
 * PlantCanvas owns the 2D canvas and the frame loop; in 3D mode it hands
 * each frame here instead of drawing the plant. This module:
 *  - loads the renderer (view3d.ts, the only file that imports three.js)
 *    the first time it is needed, so three.js stays out of the main bundle;
 *  - keeps the scene model in step with the plant (rebuilt only when
 *    `sceneSignature` changes) and pushes live colours every frame;
 *  - turns a click without a drag on the 3D canvas into a pick, and the
 *    canvas's selection into the 3D highlight.
 *
 * The 3D canvas sits in its own container UNDER the 2D canvas, which stays
 * on top (transparent, pointer-events off) to draw the colour legend.
 */
import type { PlantState, Connection } from '../../types';
import type { SimulationState } from '../../simulation';
import type { View3D, Pick3D } from './view3d';
import { buildScene3D, sceneSignature, connectionKey } from './scene-model';
import { partColors } from './scene-colors';
import type { Scene3DModel } from './types';

/** A press that moves less than this (px) before release is a click, not an orbit/pan. */
const CLICK_SLOP_PX = 5;

export type Pick3DResult =
  | { kind: 'component'; componentId: string }
  | { kind: 'connection'; connection: Connection }
  | { kind: 'none' };

export class Scene3DController {
  private readonly host: HTMLElement;
  private container: HTMLDivElement | null = null;
  private view: View3D | null = null;
  private loading: Promise<View3D> | null = null;
  private model: Scene3DModel | null = null;
  private signature: string | null = null;
  /** Frame the camera on the plant the next time a frame is drawn (a plant was loaded). */
  private frameOnNext = true;
  private highlightKey = '';
  private press: { id: number; x: number; y: number } | null = null;
  private plant: PlantState | null = null;
  private insets = { left: 0, top: 0, right: 0, bottom: 0 };

  /** Wall time of the last 3D frame (model sync + colours + render), ms. */
  public lastFrameMs = 0;
  /** A click (no drag) in the 3D view, resolved to what it hit. */
  public onPick?: (hit: Pick3DResult) => void;

  /** `host` is the element the 2D canvas lives in; the 3D canvas goes in a layer under it. */
  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** True once the renderer is loaded and running. */
  get ready(): boolean {
    return this.view !== null;
  }

  /**
   * Load three.js and start the renderer, if not already done. Rejects (with
   * the reason) when the module will not load or WebGL is unavailable; the
   * caller tells the player and stays in its current view.
   */
  async load(before: Element | null): Promise<void> {
    if (this.view) return;
    if (!this.loading) {
      this.loading = (async () => {
        const mod = await import('./view3d');
        const container = document.createElement('div');
        container.id = 'view3d-container';
        Object.assign(container.style, {
          position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'none',
        });
        this.host.insertBefore(container, before);
        try {
          const view = new mod.View3D(container);
          view.setInsets(this.insets);
          this.container = container;
          this.attachPointer(container);
          return view;
        } catch (e) {
          container.remove();
          throw e;
        }
      })();
    }
    try {
      this.view = await this.loading;
    } catch (e) {
      this.loading = null;   // allow another try later
      throw e;
    }
  }

  setVisible(visible: boolean): void {
    if (!this.view || !this.container) return;
    this.container.style.display = visible ? 'block' : 'none';
    this.view.setVisible(visible);
    if (visible) this.view.resize();
  }

  resize(): void {
    this.view?.resize();
  }

  /** Frame the whole plant on the next frame (a different plant was loaded, or Reset View). */
  requestFrameAll(): void {
    this.frameOnNext = true;
  }

  /** Screen edges covered by floating panels (px): the 3D picture centres itself in the rest. */
  setInsets(insets: { left: number; top: number; right: number; bottom: number }): void {
    this.insets = insets;
    this.view?.setInsets(insets);
  }

  zoomBy(factor: number): void {
    this.view?.zoomBy(factor);
  }

  /** The renderer, for debugging and probes. */
  get debugView(): View3D | null {
    return this.view;
  }

  renderFrame(plant: PlantState, sim: SimulationState | null,
              selection: { componentId: string | null; connection: Connection | null }): void {
    const view = this.view;
    if (!view) return;
    const t0 = performance.now();
    this.plant = plant;
    const sig = sceneSignature(plant);
    if (sig !== this.signature || !this.model) {
      const model = buildScene3D(plant);
      view.setModel(model);
      this.model = model;
      this.signature = sig;
      this.highlightKey = '';   // re-apply the selection to the new parts
    }
    if (this.frameOnNext) {
      view.frameAll();
      this.frameOnNext = false;
    }
    const conn = selection.connection && plant.connections.includes(selection.connection) ? selection.connection : null;
    const key = selection.componentId ? `c:${selection.componentId}` : conn ? `k:${connectionKey(conn)}` : '';
    if (key !== this.highlightKey) {
      view.setHighlight(selection.componentId ? { componentId: selection.componentId }
        : conn ? { connectionKey: connectionKey(conn) } : null);
      this.highlightKey = key;
    }
    view.setColors(partColors(this.model, plant, sim));
    view.render();
    this.lastFrameMs = performance.now() - t0;
  }

  private attachPointer(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) { this.press = null; return; }
      this.press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      const p = this.press;
      this.press = null;
      if (!p || p.id !== e.pointerId || e.button !== 0) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return;
      this.pickAt(e.clientX, e.clientY);
    });
    el.addEventListener('pointercancel', () => { this.press = null; });
  }

  /** Resolve a click at client coordinates and report it through onPick. */
  pickAt(clientX: number, clientY: number): Pick3DResult {
    const el = this.container;
    if (!el) return { kind: 'none' };
    const r = el.getBoundingClientRect();
    const out = this.hitAt({ x: clientX - r.left, y: clientY - r.top });
    this.onPick?.(out);
    return out;
  }

  /** What is under a point (px from the view's top-left corner); reports nothing. */
  hitAt(point: { x: number; y: number }): Pick3DResult {
    const view = this.view;
    if (!view) return { kind: 'none' };
    const hit: Pick3D | null = view.pick(point);
    let out: Pick3DResult = { kind: 'none' };
    if (hit?.componentId) {
      out = { kind: 'component', componentId: hit.componentId };
    } else if (hit?.connectionKey) {
      const conn = this.plant?.connections.find(c => connectionKey(c) === hit.connectionKey);
      if (!conn) {
        // The model was built from this plant's connections, so a miss means the two have drifted apart
        console.error(`[3D view] picked connection ${hit.connectionKey}, which the plant no longer has`);
      } else {
        out = { kind: 'connection', connection: conn };
      }
    }
    return out;
  }
}
