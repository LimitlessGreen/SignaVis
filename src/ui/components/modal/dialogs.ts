// dialogs.ts — promise-based in-app replacements for window.alert / confirm / prompt.
// Uses the shared .app-modal styles and ModalManager (focus trap, Escape, backdrop click).
import ModalManager from './modal-manager.ts';
import './dialogs.scss';

export interface DialogOptions {
  title?: string;
  /** Plain text; blank lines start a new paragraph. */
  message?: string;
  /** Smaller hint paragraph under the message. */
  hint?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Styles the OK button as destructive (red). */
  danger?: boolean;
}

export interface PromptOptions extends DialogOptions {
  defaultValue?: string;
  placeholder?: string;
}

type Result = { ok: boolean; value: string };

function openDialog(opts: PromptOptions, kind: 'alert' | 'confirm' | 'prompt'): Promise<Result> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-modal-backdrop app-dialog-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'app-modal app-dialog';
    dialog.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
    backdrop.appendChild(dialog);

    if (opts.title) {
      const h = document.createElement('h3');
      h.className = 'modal-title';
      h.textContent = opts.title;
      dialog.appendChild(h);
    }
    for (const para of (opts.message || '').split(/\n\s*\n/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.className = 'app-dialog-text';
      p.textContent = para.trim();
      dialog.appendChild(p);
    }
    if (opts.hint) {
      const p = document.createElement('p');
      p.className = 'app-modal-hint';
      p.textContent = opts.hint;
      dialog.appendChild(p);
    }

    let input: HTMLInputElement | null = null;
    if (kind === 'prompt') {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'input app-dialog-input';
      input.value = opts.defaultValue ?? '';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      dialog.appendChild(input);
    }

    const actions = document.createElement('div');
    actions.className = 'app-modal-actions';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'tb-btn app-dialog-ok' + (opts.danger ? ' app-dialog-ok--danger' : '');
    okBtn.textContent = opts.okLabel || 'OK';
    actions.appendChild(okBtn);
    let cancelBtn: HTMLButtonElement | null = null;
    if (kind !== 'alert') {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'tb-btn';
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      actions.appendChild(cancelBtn);
    }
    dialog.appendChild(actions);

    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      manager.close();
      manager.dispose();
      backdrop.remove();
      resolve({ ok: kind === 'alert' ? true : ok, value: input?.value ?? '' });
    };
    const manager = new ModalManager({ backdrop, dialog, onClose: () => finish(false) } as any);
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn?.addEventListener('click', () => finish(false));
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    });
    // Keep app shortcuts (space = play etc.) from firing while the dialog is open.
    backdrop.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });

    document.body.appendChild(backdrop);
    manager.open();
    setTimeout(() => {
      if (input) { input.focus(); input.select(); }
      else okBtn.focus();
    }, 0);
  });
}

/** In-app alert. Resolves when dismissed. */
export async function appAlert(message: string, opts: DialogOptions = {}): Promise<void> {
  await openDialog({ ...opts, message }, 'alert');
}

/** In-app confirm. Resolves true for OK, false for Cancel / Escape / backdrop. */
export async function appConfirm(message: string, opts: DialogOptions = {}): Promise<boolean> {
  return (await openDialog({ ...opts, message }, 'confirm')).ok;
}

/** In-app prompt. Resolves the entered text, or null when cancelled. */
export async function appPrompt(message: string, defaultValue = '', opts: PromptOptions = {}): Promise<string | null> {
  const r = await openDialog({ ...opts, message, defaultValue }, 'prompt');
  return r.ok ? r.value : null;
}
