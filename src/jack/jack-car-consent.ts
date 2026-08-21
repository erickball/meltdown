/**
 * Consent dialog for Jack's Corrective Action Reports.
 *
 * A CAR leaves the user's machine for our Firestore, and it carries more than
 * the sentence Jack wrote: his description quotes whatever he was looking at,
 * and the auto-collected context block includes the browser's user-agent
 * string. Nothing goes out until the user has seen exactly what it says and
 * pressed the button, so this dialog shows the WHOLE payload verbatim - no
 * summaries, no "...and diagnostic data" hand-waving.
 *
 * The technical-context block is separately declinable: a user who is happy to
 * report the bug but not to hand over their user-agent can uncheck it and
 * still file. The dialog is built the same way as the rest of the Jack UI
 * (programmatic DOM + inline cssText, see jack-plot.ts) so it needs no markup
 * in index.html.
 */

export interface CarConsentRequest {
  title: string;
  description: string;
  severity: unknown;
  component?: string;
  context: Record<string, unknown>;
}

export interface CarConsentDecision {
  approved: boolean;
  /** False when the user kept the report but declined the context block. */
  includeContext: boolean;
}

const DENIED: CarConsentDecision = { approved: false, includeContext: false };

/** Human labels for the context keys, so the dialog isn't raw JSON. */
const CONTEXT_LABELS: Record<string, string> = {
  mode: 'Current mode',
  simTime: 'Simulation time (s)',
  selectedComponent: 'Selected component',
  componentCount: 'Number of components in your plant',
  userAgent: 'Browser user-agent',
};

function formatContextValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  return String(value);
}

/**
 * Show the report to the user and resolve with their decision. Resolves
 * DENIED on Escape, backdrop click, or the "Don't send" button - anything
 * other than an explicit press of "Send report" is a no.
 */
export function requestCarConsent(req: CarConsentRequest): Promise<CarConsentDecision> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.id = 'jack-car-consent';
    // Above EVERYTHING: Jack (900), his plot panels (901), the app's own
    // dialogs (1000), and the game-mode overlays (title 5000, dialogue 6000,
    // accident banner 6500). This modal holds a promise the tool is blocked
    // on, so if it ever rendered behind something the user could neither
    // approve nor dismiss it and Jack would wait forever.
    backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(0, 0, 0, 0.6);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Consolas', monospace;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      width: min(620px, 92vw); max-height: 86vh; overflow-y: auto;
      background: #1a1e24; border: 1px solid #445566; border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6); color: #d0d8e0;
      padding: 16px 18px; font-size: 13px; line-height: 1.5;
    `;

    const heading = document.createElement('div');
    heading.textContent = 'Send this bug report?';
    heading.style.cssText =
      'font-size: 15px; color: #7af; font-weight: bold; margin-bottom: 6px;';
    panel.appendChild(heading);

    const blurb = document.createElement('div');
    blurb.textContent =
      "Jack wants to file this report with the developers. It will be sent over " +
      "the internet and stored. Nothing is sent unless you approve it here.";
    blurb.style.cssText = 'color: #99aacc; margin-bottom: 14px; font-size: 12px;';
    panel.appendChild(blurb);

    // --- the report itself ---------------------------------------------
    const section = (label: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.textContent = label;
      el.style.cssText =
        'font-size: 11px; color: #7788aa; text-transform: uppercase; ' +
        'letter-spacing: 0.5px; margin: 12px 0 4px;';
      panel.appendChild(el);
      return el;
    };
    /** textContent everywhere - a report must never inject markup. */
    const field = (text: string, mono = false): HTMLDivElement => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = `
        background: #12161c; border: 1px solid #2a3340; border-radius: 4px;
        padding: 7px 9px; white-space: pre-wrap; word-break: break-word;
        ${mono ? 'font-size: 11px; color: #b8c4d0;' : ''}
      `;
      panel.appendChild(el);
      return el;
    };

    section('Title');
    field(req.title);

    section('Description');
    const desc = field(req.description);
    desc.style.maxHeight = '190px';
    desc.style.overflowY = 'auto';

    const severity = typeof req.severity === 'string' ? req.severity : 'medium';
    section('Severity / component');
    field(`${severity}${req.component ? `  -  ${req.component}` : ''}`);

    // --- the separately-declinable context block ------------------------
    const contextKeys = Object.keys(req.context);
    const contextToggle = document.createElement('input');
    contextToggle.type = 'checkbox';
    contextToggle.checked = true;
    contextToggle.id = 'jack-car-consent-context';

    if (contextKeys.length > 0) {
      const label = document.createElement('label');
      label.htmlFor = contextToggle.id;
      label.title =
        'Diagnostic details collected automatically. They help reproduce the bug, ' +
        'but the report can be filed without them.';
      label.style.cssText =
        'display: flex; align-items: center; gap: 7px; margin: 14px 0 4px; ' +
        'font-size: 11px; color: #7788aa; text-transform: uppercase; ' +
        'letter-spacing: 0.5px; cursor: pointer;';
      label.appendChild(contextToggle);
      const labelText = document.createElement('span');
      labelText.textContent = 'Also include technical context';
      label.appendChild(labelText);
      panel.appendChild(label);

      const contextBox = document.createElement('div');
      contextBox.style.cssText = `
        background: #12161c; border: 1px solid #2a3340; border-radius: 4px;
        padding: 7px 9px; font-size: 11px; color: #b8c4d0;
      `;
      for (const key of contextKeys) {
        const row = document.createElement('div');
        row.style.cssText =
          'display: flex; gap: 8px; justify-content: space-between; ' +
          'padding: 2px 0; word-break: break-word;';
        const k = document.createElement('span');
        k.textContent = CONTEXT_LABELS[key] ?? key;
        k.style.cssText = 'color: #7788aa; flex: 0 0 auto;';
        const v = document.createElement('span');
        v.textContent = formatContextValue(req.context[key]);
        v.style.cssText = 'text-align: right; word-break: break-all;';
        row.appendChild(k);
        row.appendChild(v);
        contextBox.appendChild(row);
      }
      panel.appendChild(contextBox);

      // Dim the block when declined, so the choice is visible at a glance
      contextToggle.addEventListener('change', () => {
        contextBox.style.opacity = contextToggle.checked ? '1' : '0.35';
      });
    }

    // --- buttons ---------------------------------------------------------
    const buttonRow = document.createElement('div');
    buttonRow.style.cssText =
      'display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;';

    const baseBtn = `
      padding: 7px 16px; border-radius: 4px; cursor: pointer;
      font-family: inherit; font-size: 12px;
    `;
    const denyBtn = document.createElement('button');
    denyBtn.textContent = "Don't send";
    denyBtn.title = 'Discard the report. Nothing leaves your machine.';
    denyBtn.style.cssText =
      baseBtn + 'background: #262c36; border: 1px solid #445566; color: #d0d8e0;';

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send report';
    sendBtn.title = 'Send exactly what is shown above to the developers.';
    sendBtn.style.cssText =
      baseBtn + 'background: #2a5580; border: 1px solid #7af; color: #eaf2ff;';

    buttonRow.appendChild(denyBtn);
    buttonRow.appendChild(sendBtn);
    panel.appendChild(buttonRow);
    backdrop.appendChild(panel);

    // --- resolution ------------------------------------------------------
    let settled = false;
    const finish = (decision: CarConsentDecision) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      backdrop.remove();
      resolve(decision);
    };
    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();  // don't also close a dialog behind us
        finish(DENIED);
      }
    }

    denyBtn.addEventListener('click', () => finish(DENIED));
    sendBtn.addEventListener('click', () =>
      finish({ approved: true, includeContext: contextToggle.checked })
    );
    // Backdrop click cancels, but only when the press STARTED on the backdrop
    // (matches ConnectionDialog: dragging a text selection out must not cancel)
    let downOnBackdrop = false;
    backdrop.addEventListener('mousedown', (e) => {
      downOnBackdrop = e.target === backdrop;
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && downOnBackdrop) finish(DENIED);
      downOnBackdrop = false;
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(backdrop);
    // Default focus on the safe choice, so a stray Enter does not send
    denyBtn.focus();
  });
}
