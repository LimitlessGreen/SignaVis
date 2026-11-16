/**
 * Onboarding wizard — ONE dialog on first start that walks through the basics needed for
 * Xeno-canto annotation sets (name, XC user ID, organisation, default license, API key) and,
 * in the browser, where the project lives. Replaces the stack of single dialogs on first run.
 *
 * Everything stays editable later (Upload tab → Author, XC API Key, Project tab).
 */
import ModalManager from '../modal/modal-manager.ts';

export interface OnboardingProfile {
  name: string; xcUsername: string; owner: string; license: string;
  update(u: Record<string, unknown>): void;
}

export interface OnboardingOptions {
  profile: OnboardingProfile;
  licenses: string[];
  getApiKey: () => string;
  saveApiKey: (key: string) => void;
  /** Offer the project-folder step (web with File System Access only). */
  storage?: { recentName?: string | null } | null;
}

export interface OnboardingResult {
  completed: boolean;              // false = closed early ("Skip setup" / Escape)
  storage: 'folder' | 'browser' | null;
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function openOnboardingWizard(opts: OnboardingOptions): Promise<OnboardingResult> {
  const { profile, licenses, storage } = opts;
  const steps = ['welcome', 'author', 'xc', ...(storage ? ['storage'] : [])];
  let idx = 0;
  let storageChoice: 'folder' | 'browser' | null = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'app-modal-backdrop';
  backdrop.hidden = true;
  const dialog = document.createElement('div');
  dialog.className = 'app-modal onboarding-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'onbTitle');

  const licenseOpts = licenses.filter(Boolean)
    .map((l) => `<option value="${esc(l)}"${l === profile.license ? ' selected' : ''}>${esc(l)}</option>`).join('');

  dialog.innerHTML = `
    <div class="onb-progress" aria-hidden="true">${steps.map(() => '<span class="onb-dot"></span>').join('')}</div>
    <p class="onb-stepno" id="onbStepNo"></p>

    <section class="onb-page" data-step="welcome">
      <h3 id="onbTitle">Welcome to SignaVis</h3>
      <p>Label bird sounds in Xeno-canto recordings or your own audio and share the labels as annotation sets.</p>
      <p>A few details first — they are written into every annotation set you export or upload, so you don’t have to type them each time.</p>
      <p class="app-modal-hint">Takes under a minute. Everything can be changed later in the Upload tab.</p>
    </section>

    <section class="onb-page" data-step="author">
      <h3>About you</h3>
      <p>Credited as creator of your annotation sets.</p>
      <label class="onb-field"><span>Full name <em>required for upload</em></span>
        <input class="input" id="onbName" type="text" autocomplete="name" placeholder="e.g. Jane Doe" value="${esc(profile.name)}"></label>
      <label class="onb-field"><span>Xeno-canto user ID <em>optional</em></span>
        <input class="input" id="onbXcId" type="text" placeholder="e.g. ABCDEFGHIJ" value="${esc(profile.xcUsername)}"></label>
      <p class="app-modal-hint onb-fieldhint">The ID in your contributor link on xeno-canto.org (Your account → profile link …/contributor/<strong>ID</strong>). Without it, XC records you only as uploader, not as creator.</p>
      <label class="onb-field"><span>Organisation <em>optional</em></span>
        <input class="input" id="onbOwner" type="text" autocomplete="organization" placeholder="Organisation or person owning the set" value="${esc(profile.owner)}"></label>
    </section>

    <section class="onb-page" data-step="xc">
      <h3>Xeno-canto</h3>
      <p>An API key lets the app load existing XC labels and upload your annotation sets.</p>
      <label class="onb-field"><span>API key <em>optional</em></span>
        <input class="input" id="onbApiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your API key…"></label>
      <p class="app-modal-hint onb-fieldhint">Find it at <a href="https://xeno-canto.org/account" target="_blank" rel="noopener noreferrer">xeno-canto.org/account</a>. Stored only on this device.</p>
      <label class="onb-field"><span>Default license for your annotations</span>
        <select class="input" id="onbLicense">${licenseOpts}</select></label>
    </section>

    ${storage ? `
    <section class="onb-page" data-step="storage">
      <h3>Where should your project live?</h3>
      <div class="pf-options">
        <button type="button" class="pf-option pf-option--rec" data-storage="folder">
          <span class="pf-option-icon" aria-hidden="true">📁</span>
          <span class="pf-option-body">
            <span class="pf-option-title">${storage.recentName ? `Reopen “${esc(storage.recentName)}”` : 'Project folder'} <span class="pf-badge">Recommended</span></span>
            <span class="pf-option-text">Labels, XC downloads and your audio together in one folder. Safe from clearing browser data, easy to back up.</span>
          </span>
        </button>
        <button type="button" class="pf-option" data-storage="browser">
          <span class="pf-option-icon" aria-hidden="true">🌐</span>
          <span class="pf-option-body">
            <span class="pf-option-title">Browser only</span>
            <span class="pf-option-text">Fine for a quick look — lost when site data is cleared. You can switch later in the Project tab.</span>
          </span>
        </button>
      </div>
    </section>` : ''}

    <div class="onb-actions">
      <button class="link-btn onb-skip" type="button" id="onbSkip">Skip setup</button>
      <span class="onb-spacer"></span>
      <button class="tb-btn" type="button" id="onbBack">Back</button>
      <button class="tb-btn onb-next" type="button" id="onbNext">Next</button>
    </div>`;

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector(sel) as T;
  const nameIn = $<HTMLInputElement>('#onbName');
  const xcIdIn = $<HTMLInputElement>('#onbXcId');
  const ownerIn = $<HTMLInputElement>('#onbOwner');
  const keyIn = $<HTMLInputElement>('#onbApiKey');
  const licIn = $<HTMLSelectElement>('#onbLicense');
  const backBtn = $<HTMLButtonElement>('#onbBack');
  const nextBtn = $<HTMLButtonElement>('#onbNext');
  keyIn.value = opts.getApiKey() || '';

  // Save as you go, so "Skip setup" halfway keeps what was typed
  const commit = () => {
    profile.update({
      name: nameIn.value.trim(), xcUsername: xcIdIn.value.trim(),
      owner: ownerIn.value.trim(), license: licIn.value || profile.license,
    });
    const key = keyIn.value.trim();
    if (key && key !== (opts.getApiKey() || '')) opts.saveApiKey(key);
  };

  return new Promise<OnboardingResult>((resolve) => {
    let done = false;
    const finish = (completed: boolean) => {
      if (done) return;
      done = true;
      commit();
      mm.close(); mm.dispose(); backdrop.remove();
      resolve({ completed, storage: storageChoice });
    };
    const mm = new ModalManager({ backdrop, dialog, onClose: () => finish(false) } as any);

    const render = () => {
      const step = steps[idx];
      dialog.querySelectorAll<HTMLElement>('.onb-page').forEach((p) => { p.hidden = p.dataset.step !== step; });
      dialog.querySelectorAll('.onb-dot').forEach((d, i) => {
        d.classList.toggle('is-done', i < idx); d.classList.toggle('is-current', i === idx);
      });
      $('#onbStepNo').textContent = `Step ${idx + 1} of ${steps.length}`;
      backBtn.hidden = idx === 0;
      const last = idx === steps.length - 1;
      // The storage step is answered by its two option buttons
      nextBtn.hidden = step === 'storage';
      nextBtn.textContent = idx === 0 ? 'Get started' : last ? 'Finish' : 'Next';
      const focus = step === 'author' ? nameIn : step === 'xc' ? keyIn
        : step === 'storage' ? $('.pf-option--rec') : nextBtn;
      setTimeout(() => focus?.focus(), 30);
    };

    nextBtn.addEventListener('click', () => {
      commit();
      if (idx < steps.length - 1) { idx++; render(); } else finish(true);
    });
    backBtn.addEventListener('click', () => { commit(); if (idx > 0) { idx--; render(); } });
    $('#onbSkip').addEventListener('click', () => finish(false));
    dialog.querySelectorAll<HTMLElement>('[data-storage]').forEach((b) => b.addEventListener('click', () => {
      storageChoice = b.dataset.storage as 'folder' | 'browser';
      finish(true);
    }));
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); nextBtn.click(); }
    });

    mm.open();
    render();
  });
}
