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
          <button id="jack-close" title="Close chat">×</button>
        </div>
        <div id="jack-log"></div>
        <div id="jack-input-row">
          <textarea id="jack-input" rows="2"
            placeholder="Ask Jack... (Enter to send)"></textarea>
          <button id="jack-send" title="Send">▶</button>
        </div>
      </div>
      <div id="jack-portrait" title="Chat with Jack, head of operations at Atom Enterprises — your EPC contractor. He can explain, troubleshoot, and modify your plant.">
        ${jackPortraitSvg()}
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
    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  private togglePanel(open?: boolean): void {
    const show = open ?? this.panel.classList.contains('hidden');
    this.panel.classList.toggle('hidden', !show);
    if (show) {
      this.input.focus();
      if (!this.introduced && this.messages.length === 0) {
        this.introduced = true;
        void this.converse('__INTRO__', true);
      }
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
    this.input.value = '';
    this.addBubble('jack-msg-user', text);
    void this.converse(text, false);
  }

  // ------------------------------------------------------------------
  // Conversation loop: send -> maybe execute tools -> send results -> ...
  // ------------------------------------------------------------------
  private async converse(userText: string, isIntro: boolean): Promise<void> {
    // On any failure, roll the transcript back to here so a dangling
    // tool_use turn can't poison the next request.
    const checkpoint = this.messages.length;
    const content: ContentBlock[] = [];
    if (!isIntro) {
      content.push({
        type: 'text',
        text: buildContextBlock(this.host, this.changes),
      });
    }
    content.push({ type: 'text', text: userText });
    this.messages.push({ role: 'user', content });

    this.setBusy(true);
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const resp = await fetch(this.endpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: this.messages }),
        });
        if (!resp.ok) {
          let jackSays = `Line's dead (HTTP ${resp.status}). Try me again in a bit.`;
          try {
            const errBody = await resp.json();
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
          }
        }

        const toolUses = data.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use'
        );
        if (data.stop_reason !== 'tool_use' || toolUses.length === 0) return;

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
      this.addBubble(
        'jack-msg-error',
        `Can't reach the site office (${String(e)}). Check your connection and try again.`
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
    case 'connect_components':
      return `🔧 Jack runs pipe from ${i.from} to ${i.to}`;
    case 'delete_component':
      return `🔧 Jack removes ${i.component}`;
    default:
      return `🔧 Jack uses ${tu.name}`;
  }
}

function jackPortraitSvg(): string {
  // Corny-90s pixel-adjacent portrait: hard hat (JACK), squint, mustache.
  return `
  <svg viewBox="0 0 64 64" width="72" height="72" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="32" r="31" fill="#1a2438" stroke="#e8b840" stroke-width="2"/>
    <ellipse cx="32" cy="44" rx="16" ry="14" fill="#d9a066"/>
    <rect x="16" y="52" width="32" height="12" fill="#3a5a8c"/>
    <rect x="28" y="50" width="8" height="6" fill="#d9a066"/>
    <path d="M 12 30 Q 12 14 32 14 Q 52 14 52 30 L 54 30 L 54 34 L 10 34 L 10 30 Z" fill="#e8b840"/>
    <rect x="27" y="10" width="10" height="6" rx="2" fill="#e8b840"/>
    <text x="32" y="31" font-family="monospace" font-size="9" font-weight="bold"
      fill="#7a5c10" text-anchor="middle">JACK</text>
    <rect x="20" y="38" width="8" height="2.5" rx="1" fill="#4a3520"/>
    <rect x="36" y="38" width="8" height="2.5" rx="1" fill="#4a3520"/>
    <rect x="22" y="47" width="20" height="4" rx="2" fill="#8a6a40"/>
    <ellipse cx="32" cy="45" rx="3" ry="2" fill="#c08850"/>
  </svg>`;
}
