/**
 * Chiptune audio for career mode: a tiny WebAudio square/triangle sequencer
 * doing its best impression of a 1994 sound card. Tunes are note lists
 * (semitone offsets from A4, or null for rests) with fixed step lengths.
 *
 * Browsers block audio until a user gesture; ChipTunes.unlock() is called
 * from the first click on any career overlay.
 */

type Step = number | null;          // semitones from A440, null = rest

interface Tune {
  bpm: number;                      // steps per minute is bpm*2 (eighth notes)
  lead: Step[];
  bass?: Step[];                    // half-time (one bass step per two lead steps)
  loop: boolean;
  leadWave?: OscillatorType;
}

const TUNES: Record<string, Tune> = {
  // Title: portentous minor fanfare, then it just keeps being portentous.
  title: {
    bpm: 92, loop: true, leadWave: 'square',
    lead: [0, null, 0, 3, 5, null, 3, null, 0, null, -2, 0, 3, null, null, null,
           0, null, 0, 3, 7, null, 5, null, 3, 2, 0, -2, 0, null, null, null],
    bass: [-24, -24, -21, -19, -24, -24, -17, -19,
           -24, -24, -21, -19, -22, -22, -24, -24],
  },
  // Briefing: jaunty corporate muzak. Someone is about to lose money.
  briefing: {
    bpm: 118, loop: true, leadWave: 'square',
    lead: [0, 4, 7, 4, 9, 7, 4, 0, 2, 5, 9, 5, 7, null, 4, null,
           0, 4, 7, 4, 12, null, 9, 7, 5, 4, 2, 4, 0, null, null, null],
    bass: [-12, -5, -8, -5, -10, -3, -12, -5,
           -12, -5, -8, -5, -10, -10, -12, -12],
  },
  // Victory: three-chord fanfare with an extra chord for the shareholders.
  victory: {
    bpm: 140, loop: false, leadWave: 'square',
    lead: [0, 4, 7, 12, null, 12, 12, null, 14, 12, 11, 12, 16, null, null, null,
           16, 16, 17, 19, 19, null, 12, 14, 16, null, null, null, null, null, null, null],
    bass: [-12, -12, -8, -5, -7, -7, -5, -5,
           -8, -8, -3, -3, -5, -5, -5, -5],
  },
  // Disaster: the trombone section has been informed of the release fractions.
  disaster: {
    bpm: 66, loop: false, leadWave: 'triangle',
    lead: [0, null, -1, null, -3, null, -5, null, -8, null, null, null, -8, -9, -10, null,
           -12, null, null, null, -12, -13, -15, null, -20, null, null, null, null, null, null, null],
    bass: [-24, -24, -25, -25, -27, -27, -29, -29,
           -32, -32, -32, -32, -36, -36, -36, -36],
  },
  // Money: short cash-register arpeggio for payouts (SFX-ish).
  money: {
    bpm: 200, loop: false, leadWave: 'square',
    lead: [12, 16, 19, 24, null, 24, null, null],
  },
};

export class ChipTunes {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private current: string | null = null;
  private _muted: boolean;

  constructor(muted: boolean) {
    this._muted = muted;
  }

  get muted(): boolean { return this._muted; }

  setMuted(m: boolean): void {
    this._muted = m;
    if (m) this.stop();
  }

  /** Must be called from a user-gesture handler at least once. */
  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.12; // background music, not a demonstration
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null; // no audio; the game shrugs and carries on
    }
  }

  play(name: string): void {
    if (this._muted) { this.current = name; return; }
    if (!this.ctx || !this.master) { this.current = name; return; }
    if (this.current === name && this.timer !== null) return;
    this.stop();
    this.current = name;

    const tune = TUNES[name];
    if (!tune) return;
    const stepSec = 60 / tune.bpm / 2;
    let step = 0;

    const tick = () => {
      if (!this.ctx || !this.master) return;
      const i = step % tune.lead.length;
      if (!tune.loop && step >= tune.lead.length) { this.stop(); return; }

      const lead = tune.lead[i];
      if (lead !== null) {
        this.blip(440 * Math.pow(2, lead / 12), stepSec * 0.9, tune.leadWave ?? 'square', 1.0);
      }
      if (tune.bass && i % 2 === 0) {
        const b = tune.bass[(i / 2) % tune.bass.length];
        if (b !== null) {
          this.blip(440 * Math.pow(2, b / 12), stepSec * 1.7, 'triangle', 1.4);
        }
      }
      step++;
    };

    tick();
    this.timer = window.setInterval(tick, stepSec * 1000);
  }

  /** One-shot sound effects. */
  sfx(kind: 'click' | 'cash' | 'alarm' | 'thud'): void {
    if (this._muted || !this.ctx || !this.master) return;
    switch (kind) {
      case 'click': this.blip(880, 0.04, 'square', 0.5); break;
      case 'cash': this.play('money'); break;
      case 'alarm':
        this.blip(660, 0.15, 'square', 0.8);
        setTimeout(() => this.blip(520, 0.15, 'square', 0.8), 180);
        setTimeout(() => this.blip(660, 0.15, 'square', 0.8), 360);
        break;
      case 'thud': this.blip(80, 0.25, 'triangle', 2.0); break;
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.current = null;
  }

  private blip(freq: number, dur: number, wave: OscillatorType, gain: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.5 * gain, t);
    env.gain.exponentialRampToValueAtTime(0.01, t + dur);
    osc.connect(env);
    env.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
