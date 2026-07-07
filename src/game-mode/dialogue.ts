/**
 * DialogueOverlay: the corny 90s click-through story scenes.
 *
 * Full-screen dark overlay with CRT scanlines, a chunky dialogue box, a
 * pixel portrait (2-frame talk animation while the typewriter runs, idle
 * blink otherwise), the speaker's name in period-correct all-caps, and a
 * blinking "CLICK TO CONTINUE" prompt. Click / Space / Enter advances;
 * a click mid-typing completes the line first (as is law).
 */

import { DialogueLine } from './types';
import { renderPortrait, characterDisplayName, SPRITE_SIZE } from './sprites';
import { ChipTunes } from './music';

const PORTRAIT_SCALE = 7;

export class DialogueOverlay {
  private overlay: HTMLDivElement | null = null;
  private portraitCtx: CanvasRenderingContext2D | null = null;
  private nameEl: HTMLDivElement | null = null;
  private textEl: HTMLDivElement | null = null;
  private promptEl: HTMLDivElement | null = null;

  private lines: DialogueLine[] = [];
  private lineIndex = 0;
  private charIndex = 0;
  private typeTimer: number | null = null;
  private animTimer: number | null = null;
  private animTick = 0;
  private onDone: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(private tunes: ChipTunes) {}

  get isOpen(): boolean { return this.overlay !== null; }

  show(lines: DialogueLine[], onDone: () => void): void {
    this.dismiss();
    this.lines = lines;
    this.lineIndex = 0;
    this.onDone = onDone;
    this.buildDom();
    this.startLine();
  }

  /** Tear down without firing the completion callback. */
  dismiss(): void {
    if (this.typeTimer !== null) { clearInterval(this.typeTimer); this.typeTimer = null; }
    if (this.animTimer !== null) { clearInterval(this.animTimer); this.animTimer = null; }
    if (this.keyHandler) { document.removeEventListener('keydown', this.keyHandler); this.keyHandler = null; }
    this.overlay?.remove();
    this.overlay = null;
  }

  private buildDom(): void {
    const overlay = document.createElement('div');
    overlay.className = 'gm-dialogue-overlay gm-scanlines';
    overlay.innerHTML = `
      <div class="gm-dialogue-box">
        <div class="gm-dialogue-portrait-frame">
          <canvas class="gm-dialogue-portrait" width="${SPRITE_SIZE * PORTRAIT_SCALE}" height="${SPRITE_SIZE * PORTRAIT_SCALE}"></canvas>
        </div>
        <div class="gm-dialogue-right">
          <div class="gm-dialogue-name"></div>
          <div class="gm-dialogue-text"></div>
          <div class="gm-dialogue-prompt">&#9660; CLICK TO CONTINUE</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const canvas = overlay.querySelector('.gm-dialogue-portrait') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(PORTRAIT_SCALE, PORTRAIT_SCALE);
    this.portraitCtx = ctx;

    this.nameEl = overlay.querySelector('.gm-dialogue-name') as HTMLDivElement;
    this.textEl = overlay.querySelector('.gm-dialogue-text') as HTMLDivElement;
    this.promptEl = overlay.querySelector('.gm-dialogue-prompt') as HTMLDivElement;

    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.tunes.unlock();
      this.advance();
    });
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.tunes.unlock();
        this.advance();
      }
    };
    document.addEventListener('keydown', this.keyHandler);

    // Portrait animation: blink at random, flap mouth while typing.
    this.animTimer = window.setInterval(() => {
      this.animTick++;
      this.renderCurrentPortrait();
    }, 120);
  }

  private currentLine(): DialogueLine | null {
    return this.lines[this.lineIndex] ?? null;
  }

  private startLine(): void {
    const line = this.currentLine();
    if (!line || !this.textEl || !this.nameEl) return;

    const { name, color } = characterDisplayName(line.who);
    this.nameEl.textContent = name;
    this.nameEl.style.color = color;
    this.textEl.textContent = '';
    if (this.promptEl) this.promptEl.style.visibility = 'hidden';
    this.charIndex = 0;

    if (this.typeTimer !== null) clearInterval(this.typeTimer);
    this.typeTimer = window.setInterval(() => {
      this.charIndex += 2; // two chars per tick: brisk but readable
      if (this.charIndex >= line.text.length) {
        this.charIndex = line.text.length;
        if (this.typeTimer !== null) { clearInterval(this.typeTimer); this.typeTimer = null; }
        if (this.promptEl) this.promptEl.style.visibility = 'visible';
      }
      if (this.textEl) this.textEl.textContent = line.text.slice(0, this.charIndex);
    }, 28);
    this.renderCurrentPortrait();
  }

  private renderCurrentPortrait(): void {
    const line = this.currentLine();
    if (!line || !this.portraitCtx) return;
    const typing = this.typeTimer !== null;
    renderPortrait(this.portraitCtx, line.who, line.mood ?? 'neutral', {
      talking: typing,
      talkFrame: this.animTick % 2 === 0,
      // idle blink: two ticks every ~3 seconds, pseudo-random phase
      blinking: !typing && (this.animTick % 25 === 0 || this.animTick % 25 === 1),
    });
  }

  private advance(): void {
    const line = this.currentLine();
    if (!line) return;
    if (this.typeTimer !== null) {
      // finish the typewriter first
      clearInterval(this.typeTimer);
      this.typeTimer = null;
      this.charIndex = line.text.length;
      if (this.textEl) this.textEl.textContent = line.text;
      if (this.promptEl) this.promptEl.style.visibility = 'visible';
      this.renderCurrentPortrait();
      return;
    }
    this.tunes.sfx('click');
    this.lineIndex++;
    if (this.lineIndex >= this.lines.length) {
      const done = this.onDone;
      this.dismiss();
      done?.();
    } else {
      this.startLine();
    }
  }
}
