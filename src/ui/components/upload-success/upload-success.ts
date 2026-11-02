// upload-success.ts — celebratory dialog after an annotation set reached Xeno-canto,
// with the steps that still happen on the XC side (import, review, publish).
import ModalManager from '../modal/modal-manager.ts';
import './upload-success.scss';

export interface UploadSuccessOptions {
  labelCount: number;
  recordingCount: number;
  setName?: string;
  /** Server answer, e.g. "Successfully uploaded … Visit https://xeno-canto.org/account to import". */
  message?: string;
  /** Upload endpoint; its origin is the fallback for the account link. */
  endpoint: string;
  /** Non-live server label (test uploads), shown as a badge. */
  testServer?: string;
}

/** Account page from the server message, else <origin of endpoint>/account. */
export function accountUrlFrom(message: string | undefined, endpoint: string): string {
  const m = /(https?:\/\/[^\s"'<>]+\/account[^\s"'<>]*)/i.exec(message || '');
  if (m) return m[1].replace(/[.,;)]+$/, '');
  try { return `${new URL(endpoint).origin}/account`; } catch { return 'https://xeno-canto.org/account'; }
}

const CHECK_SVG = '<svg class="upl-check" viewBox="0 0 52 52" aria-hidden="true">'
  + '<circle class="upl-check-circle" cx="26" cy="26" r="23" fill="none"/>'
  + '<path class="upl-check-mark" fill="none" d="M15 27 l7 7 l15 -16"/></svg>';

function confetti(host: HTMLElement) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#38bdf8', '#22c55e', '#facc15', '#f472b6', '#a78bfa', '#fb923c'];
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('i');
    p.className = 'upl-confetti';
    const angle = (Math.PI * 2 * i) / 28 + Math.random() * 0.3;
    const dist = 70 + Math.random() * 70;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist - 30}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 540 - 270)}deg`);
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${0.15 + Math.random() * 0.1}s`;
    host.appendChild(p);
  }
}

/** Show the dialog; resolves when it is closed. */
export function showUploadSuccess(opts: UploadSuccessOptions): Promise<void> {
  return new Promise((resolve) => {
    const account = accountUrlFrom(opts.message, opts.endpoint);
    const backdrop = document.createElement('div');
    backdrop.className = 'app-modal-backdrop upl-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'app-modal upl-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-labelledby', 'uplTitle');
    const labels = `${opts.labelCount} label${opts.labelCount === 1 ? '' : 's'}`;
    const recs = `${opts.recordingCount} recording${opts.recordingCount === 1 ? '' : 's'}`;
    dialog.innerHTML = `
      <div class="upl-hero">${CHECK_SVG}</div>
      <h3 class="modal-title upl-title" id="uplTitle">Sent to Xeno-canto!</h3>
      <p class="upl-sub"></p>
      <ol class="upl-steps">
        <li class="done"><span class="upl-step-dot">✓</span><div><b>Uploaded</b><span>Your set is waiting in your Xeno-canto account.</span></div></li>
        <li><span class="upl-step-dot">2</span><div><b>Import it on Xeno-canto</b><span>Open your account page, review the set and confirm the import.</span></div></li>
        <li><span class="upl-step-dot">3</span><div><b>Published</b><span>After the import the labels appear with the recordings. Uploaded sets can't be edited — to change something, delete the set there and upload again.</span></div></li>
      </ol>
      <div class="app-modal-actions upl-actions">
        <a class="tb-btn upl-primary" target="_blank" rel="noopener">Open Xeno-canto account ↗</a>
        <button type="button" class="tb-btn upl-close">Continue labeling</button>
      </div>`;
    const sub = dialog.querySelector('.upl-sub') as HTMLElement;
    sub.textContent = `${labels} from ${recs}${opts.setName ? ` · “${opts.setName}”` : ''}`;
    if (opts.testServer) {
      const b = document.createElement('span');
      b.className = 'upl-badge';
      b.textContent = opts.testServer;
      sub.append(' ', b);
    }
    const link = dialog.querySelector('.upl-primary') as HTMLAnchorElement;
    link.href = account;
    backdrop.appendChild(dialog);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      manager.close();
      manager.dispose();
      backdrop.remove();
      resolve();
    };
    const manager = new ModalManager({ backdrop, dialog, onClose: finish } as any);
    dialog.querySelector('.upl-close')!.addEventListener('click', finish);
    backdrop.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    document.body.appendChild(backdrop);
    manager.open();
    confetti(dialog.querySelector('.upl-hero') as HTMLElement);
    setTimeout(() => link.focus(), 0);
  });
}
