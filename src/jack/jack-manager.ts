import type { JackHost, PlantChange } from './jack-host';
import { buildContextBlock } from './jack-context';
import { executeJackTool } from './jack-tools-exec';
import './jack.css';

// Minimal Anthropic message shapes (kept local so the game bundle doesn't
// pull in the SDK — the server owns the real API surface).
interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

const PROD_ENDPOINT =
  'https://us-central1-unityriskresearch.cloudfunctions.net/jackChat';
const MAX_TOOL_ROUNDS = 8;

// Scripted opening line — shown instantly on first open, no API call. The
// server system prompt quotes this verbatim and tells Jack not to
// re-introduce himself; keep the two in sync.
const JACK_INTRO =
  "Jack. Head of operations, Atom Enterprises — your EPC contractor, which " +
  "is a fancy way of saying I'm the plumber. Questions, complaints, custom " +
  'hardware: I handle all of it. What are we working on, boss?';

/**
 * "Atom" Jack — the player's EPC contractor. Portrait sits in the bottom
 * right; clicking it opens a chat panel. Jack answers questions about the
 * plant and edits it through tools executed here in the browser.
 */
export class JackManager {
  private host: JackHost;
  private messages: ChatMessage[] = [];
  private changes: PlantChange[] = [];
  private busy = false;
  private introduced = false;
  private executingTool = false;

  private container!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private log!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

  constructor(host: JackHost) {
    this.host = host;
    this.journalUserEdits();
    this.buildDom();
  }

  /** Endpoint is overridable for local testing against the emulator:
   *  localStorage.setItem('jack-endpoint', 'http://127.0.0.1:5001/unityriskresearch/us-central1/jackChat') */
  private endpoint(): string {
    return localStorage.getItem('jack-endpoint') ?? PROD_ENDPOINT;
  }

  // ------------------------------------------------------------------
  // Recent-changes journal: wrap the construction manager's mutators so
  // user edits (via the normal UI) show up in Jack's context too.
  // ------------------------------------------------------------------
  private journalUserEdits(): void {
    const cm = this.host.constructionManager as any;
    const push = (description: string) => this.recordChange('user', description);
    const self = this;

    const origCreate = cm.createComponent.bind(cm);
    cm.createComponent = (config: any) => {
      const id = origCreate(config);
      if (id && !self.executingTool) push(`added ${config.type} "${config.name}" (${id})`);
      return id;
    };
    const origUpdate = cm.updateComponent.bind(cm);
    cm.updateComponent = (id: string, props: any) => {
      const ok = origUpdate(id, props);
      if (ok && !self.executingTool) push(`edited ${id}`);
      return ok;
    };
    const origDelete = cm.deleteComponent.bind(cm);
    cm.deleteComponent = (id: string) => {
      const comp = self.host.plantState.components.get(id);
      const ok = origDelete(id);
      if (ok && !self.executingTool) push(`deleted ${comp?.type ?? 'component'} ${id}`);
      return ok;
    };
    const origConnect = cm.createConnection.bind(cm);
    cm.createConnection = (...args: any[]) => {
      const ok = origConnect(...args);
      if (ok && !self.executingTool) push(`connected ${args[0]} -> ${args[1]}`);
      return ok;
    };
    const origDisconnect = cm.deleteConnection.bind(cm);
    cm.deleteConnection = (a: string, b: string) => {
      const ok = origDisconnect(a, b);
      if (ok && !self.executingTool) push(`disconnected ${a} and ${b}`);
      return ok;
    };
  }

  private recordChange(source: 'user' | 'jack', description: string): void {
    this.changes.push({
      source,
      description,
      simTime: this.host.getSimState()?.time ?? 0,
    });
    if (this.changes.length > 50) this.changes.splice(0, this.changes.length - 50);
  }

  // ------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------
  private buildDom(): void {
    this.container = document.createElement('div');
    this.container.id = 'jack-container';
    this.container.innerHTML = `
      <div id="jack-panel" class="hidden">
        <div id="jack-header">
          <span>"Atom" Jack — Atom Enterprises</span>
          <button id="jack-close" title="Collapse chat">×</button>
        </div>
        <div id="jack-log"></div>
      </div>
      <div id="jack-bottom-row">
        <div id="jack-entry">
          <textarea id="jack-input" rows="1"
            placeholder="Ask Jack..."></textarea>
          <button id="jack-send" title="Send">▶</button>
        </div>
        <div id="jack-portrait" title="&quot;Atom&quot; Jack, head of operations at Atom Enterprises — your EPC contractor. He can explain, troubleshoot, and modify your plant.">
          ${jackPortraitSvg()}
        </div>
      </div>`;
    document.getElementById('app')!.appendChild(this.container);

    this.panel = this.container.querySelector('#jack-panel')!;
    this.log = this.container.querySelector('#jack-log')!;
    this.input = this.container.querySelector('#jack-input')!;
    this.sendBtn = this.container.querySelector('#jack-send')!;

    this.container
      .querySelector('#jack-portrait')!
      .addEventListener('click', () => this.togglePanel());
    this.container
      .querySelector('#jack-close')!
      .addEventListener('click', () => this.togglePanel(false));
    this.input.addEventListener('focus', () => this.togglePanel(true));
    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.input.addEventListener('keydown', (e) => {
      // Keep keystrokes out of the game's global shortcut handlers
      // (space = pause, Delete = delete component, +/- = sim speed).
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  private togglePanel(open?: boolean): void {
    const show = open ?? this.panel.classList.contains('hidden');
    this.panel.classList.toggle('hidden', !show);
    if (show && !this.introduced) {
      // Scripted intro, rendered instantly — costs nothing, and the server
      // prompt tells Jack he already said it.
      this.introduced = true;
      this.addBubble('jack-msg-jack', JACK_INTRO);
    }
  }

  private addBubble(cls: string, text: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = `jack-msg ${cls}`;
    div.textContent = text;
    this.log.appendChild(div);
    this.log.scrollTop = this.log.scrollHeight;
    return div;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.input.disabled = busy;
    let dots = this.log.querySelector('#jack-typing');
    if (busy && !dots) {
      dots = document.createElement('div');
      dots.id = 'jack-typing';
      dots.className = 'jack-msg jack-msg-jack';
      dots.textContent = '...';
      this.log.appendChild(dots);
      this.log.scrollTop = this.log.scrollHeight;
    } else if (!busy && dots) {
      dots.remove();
    }
  }

  private handleSend(): void {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.togglePanel(true);
    this.input.value = '';
    this.addBubble('jack-msg-user', text);
    void this.converse(text);
  }

  // ------------------------------------------------------------------
  // Conversation loop: send -> maybe execute tools -> send results -> ...
  // ------------------------------------------------------------------
  private async converse(userText: string): Promise<void> {
    // On any failure, roll the transcript back to here so a dangling
    // tool_use turn can't poison the next request.
    const checkpoint = this.messages.length;
    const content: ContentBlock[] = [
      { type: 'text', text: buildContextBlock(this.host, this.changes) },
      { type: 'text', text: userText },
    ];
    this.messages.push({ role: 'user', content });

    this.setBusy(true);
    let renderedText = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Hard timeout so a wedged request shows an error instead of an
        // eternal typing indicator.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 100_000);
        let resp: Response;
        try {
          resp = await fetch(this.endpoint(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: this.messages }),
            signal: abort.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          let jackSays = `Line's dead (HTTP ${resp.status}). Try me again in a bit.`;
          try {
            const errBody = await resp.json();
            console.warn('[Jack] server error', resp.status, errBody);
            if (errBody.jackSays) jackSays = errBody.jackSays;
            else if (errBody.error) jackSays += ` [${errBody.error}]`;
          } catch {
            /* non-JSON error body */
          }
          this.addBubble('jack-msg-error', jackSays);
          this.messages.length = checkpoint;
          return;
        }

        const data = (await resp.json()) as {
          content: ContentBlock[];
          stop_reason: string;
        };
        this.messages.push({ role: 'assistant', content: data.content });

        for (const block of data.content) {
          if (block.type === 'text' && (block as TextBlock).text.trim()) {
            this.addBubble('jack-msg-jack', (block as TextBlock).text);
            renderedText = true;
          }
        }

        const toolUses = data.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use'
        );
        if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
          if (data.stop_reason === 'max_tokens') {
            this.addBubble(
              'jack-msg-error',
              'Jack got cut off mid-sentence (length limit). Ask him to pick up where he left off.'
            );
          } else if (!renderedText) {
            console.warn('[Jack] turn ended with no text', data);
            this.addBubble(
              'jack-msg-error',
              "Jack went quiet without answering — that's a bug on our end. Try asking again."
            );
          }
          return;
        }

        const results: ContentBlock[] = [];
        for (const tu of toolUses) {
          this.addBubble('jack-msg-action', describeToolCall(tu));
          let result: unknown;
          this.executingTool = true;
          try {
            result = executeJackTool(tu.name, tu.input ?? {}, this.host, (d) =>
              this.recordChange('jack', d)
            );
          } catch (e) {
            result = { ok: false, error: `Tool threw: ${String(e)}` };
          } finally {
            this.executingTool = false;
          }
          const isError =
            typeof result === 'object' &&
            result !== null &&
            (result as any).ok === false;
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: isError,
          } as ContentBlock);
        }
        this.messages.push({ role: 'user', content: results });
      }
      this.addBubble(
        'jack-msg-error',
        "Jack's gone quiet — too many back-and-forths in one request. Ask again."
      );
    } catch (e) {
      console.warn('[Jack] request failed', e);
      const timedOut = e instanceof DOMException && e.name === 'AbortError';
      this.addBubble(
        'jack-msg-error',
        timedOut
          ? "That call took too long — site office must be swamped. Ask again; you won't lose your place."
          : `Can't reach the site office (${String(e)}). Check your connection and try again.`
      );
      this.messages.length = checkpoint;
    } finally {
      this.setBusy(false);
    }
  }
}

function describeToolCall(tu: ToolUseBlock): string {
  const i = tu.input ?? {};
  switch (tu.name) {
    case 'list_component_types':
      return '🔧 Jack checks the parts catalog';
    case 'get_component_details':
      return `🔧 Jack looks over ${i.component}`;
    case 'get_simulation_state':
      return '🔧 Jack reads the gauges';
    case 'add_component':
      return `🔧 Jack installs a ${i.type} ("${i.name}")`;
    case 'edit_component':
      return `🔧 Jack adjusts ${i.component}`;
    case 'move_component':
      return `🔧 Jack relocates ${i.component} to (${i.x}, ${i.y})`;
    case 'connect_components':
      return `🔧 Jack runs pipe from ${i.from} to ${i.to}`;
    case 'delete_component':
      return `🔧 Jack removes ${i.component}`;
    default:
      return `🔧 Jack uses ${tu.name}`;
  }
}

function jackPortraitSvg(): string {
  // Jack: hi-vis vest, weathered face, wry eyebrow, big mustache, hard hat
  // stenciled JACK. Clipped to the badge circle.
  return `
  <svg viewBox="0 0 96 96" width="96" height="96" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="jack-badge"><circle cx="48" cy="48" r="45"/></clipPath>
    </defs>
    <circle cx="48" cy="48" r="45" fill="#1a2438"/>
    <g clip-path="url(#jack-badge)">
      <!-- neck + hi-vis vest -->
      <rect x="41" y="66" width="14" height="14" fill="#c98d55"/>
      <path d="M12 96 L12 88 Q29 75 48 75 Q67 75 84 88 L84 96 Z" fill="#e07020"/>
      <path d="M16 90 Q48 76 80 90" fill="none" stroke="#ffd84a" stroke-width="4"/>
      <path d="M42 76 L48 84 L54 76" fill="none" stroke="#b85812" stroke-width="2"/>
      <!-- ears + head -->
      <ellipse cx="28.5" cy="55" rx="4" ry="5.5" fill="#d9a066"/>
      <ellipse cx="67.5" cy="55" rx="4" ry="5.5" fill="#d9a066"/>
      <ellipse cx="48" cy="54" rx="19" ry="22" fill="#e0a878"/>
      <!-- stubble shading on the jaw -->
      <path d="M31 60 Q31 76 48 76 Q65 76 65 60 Q65 71 48 71 Q31 71 31 60 Z"
        fill="#c08850" opacity="0.45"/>
      <!-- eyebrows: one cocked -->
      <rect x="32" y="46.5" width="11" height="3.2" rx="1.6" fill="#5a3a1a"
        transform="rotate(-9 37.5 48)"/>
      <rect x="53" y="45.5" width="11" height="3.2" rx="1.6" fill="#5a3a1a"
        transform="rotate(5 58.5 47)"/>
      <!-- eyes -->
      <ellipse cx="38" cy="54.5" rx="4.2" ry="3.1" fill="#f5f0e6"/>
      <ellipse cx="58" cy="54.5" rx="4.2" ry="3.1" fill="#f5f0e6"/>
      <circle cx="39" cy="54.8" r="1.9" fill="#3a2a1a"/>
      <circle cx="59" cy="54.8" r="1.9" fill="#3a2a1a"/>
      <circle cx="39.6" cy="54.1" r="0.6" fill="#fff"/>
      <circle cx="59.6" cy="54.1" r="0.6" fill="#fff"/>
      <!-- nose -->
      <path d="M48 55 L46.2 61.5 Q47.8 63.4 50.2 61.8" fill="none"
        stroke="#b8804f" stroke-width="1.7" stroke-linecap="round"/>
      <!-- mustache + smirk -->
      <path d="M48 64.5 C43 62.5 37 63.5 34.5 67.5 C38.5 71.5 45 70 48 67.5
        C51 70 57.5 71.5 61.5 67.5 C59 63.5 53 62.5 48 64.5 Z" fill="#6a4423"/>
      <path d="M43.5 73 Q48 75 54 72.4" fill="none" stroke="#a06a3c"
        stroke-width="1.5" stroke-linecap="round"/>
      <!-- hard hat -->
      <path d="M27 40 Q27 17 48 17 Q69 17 69 40 Z" fill="#f2c230"/>
      <path d="M27 40 Q27 17 48 17 L48 40 Z" fill="#ffffff" opacity="0.10"/>
      <rect x="43" y="12.5" width="10" height="8" rx="3.5" fill="#f2c230"/>
      <rect x="21" y="38" width="54" height="7" rx="3.5" fill="#d9a428"/>
      <text x="48" y="34.5" font-family="Courier New, monospace" font-size="11"
        font-weight="bold" fill="#8a6510" text-anchor="middle"
        letter-spacing="0.5">JACK</text>
    </g>
    <circle cx="48" cy="48" r="45" fill="none" stroke="#e8b840" stroke-width="2.5"/>
  </svg>`;
}
