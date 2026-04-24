import ModalManager from '../src/ui/modal-manager.ts';
import JSONEditor from 'jsoneditor';
import 'jsoneditor/dist/jsoneditor.css';

export function createXcExportModal(opts = {}) {
  const { buildPayload, upload, getApiKey, getFilename, defaultCollapseDepth = 1 } = opts;

  const xcExportModal = document.createElement('div');
  xcExportModal.id = 'xcExportModal';
  xcExportModal.className = 'xc-nokey-backdrop';
  xcExportModal.hidden = true;
  xcExportModal.innerHTML = `
    <div class="xc-nokey-dialog xc-export-dialog">
      <h3>Export annotation set</h3>
      <p class="field-hint">Preview the JSON export. Use <strong>Download</strong> to save a file or <strong>Upload to XC</strong> to send it to Xeno-canto.</p>
      <div class="xc-export-actions" style="display:flex; gap:8px; margin-top:10px;">
        <button class="tb-btn" id="xcExportDownloadBtn" type="button">Download JSON</button>
        <button class="tb-btn" id="xcExportUploadBtn" type="button">Upload to XC</button>
        <button class="tb-btn" id="xcExportCopyBtn" type="button">Copy</button>
      </div>
      <div style="margin-top:12px;">
        <div id="xcExportJsonPre" class="json-pre" style="max-height:72vh; overflow:auto; background: var(--panel); border:1px solid var(--line); padding:12px; border-radius:6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Roboto Mono', 'Segoe UI Mono', monospace; font-size:13px; color:var(--text);"></div>
      </div>
      <div id="xcExportModalStatus" class="field-hint" style="margin-top:8px;"></div>
    </div>`;
  document.body.appendChild(xcExportModal);

  const modalManager = new ModalManager({ backdrop: xcExportModal, dialog: xcExportModal.querySelector('.xc-nokey-dialog') });
  const downloadBtn = xcExportModal.querySelector('#xcExportDownloadBtn');
  const uploadBtn = xcExportModal.querySelector('#xcExportUploadBtn');
  const copyBtn = xcExportModal.querySelector('#xcExportCopyBtn');
  const jsonPre = xcExportModal.querySelector('#xcExportJsonPre');
  const statusEl = xcExportModal.querySelector('#xcExportModalStatus');

  let currentJson = '';
  let jsonEditor = null;

  try {
    jsonEditor = new JSONEditor(jsonPre, {
      mode: 'view',
      navigationBar: true,
      mainMenuBar: false,
      search: true,
    });
  } catch (e) {
    jsonEditor = null;
  }

  function open() {
    try {
      const payload = (typeof buildPayload === 'function') ? buildPayload() : {};
      currentJson = JSON.stringify(payload, null, 2);
      try {
        if (jsonEditor && typeof jsonEditor.set === 'function') {
          jsonEditor.set(payload);
          try { if (typeof jsonEditor.expandAll === 'function') jsonEditor.expandAll(); } catch (e) {}
        } else {
          jsonPre.textContent = currentJson;
        }
      } catch (e) {
        jsonPre.textContent = currentJson;
      }
      statusEl.textContent = '';
      try { uploadBtn.disabled = !getApiKey(); } catch (e) {}
      modalManager.open();
      setTimeout(() => { try { jsonPre.scrollTop = 0; } catch (e) {} }, 0);
    } catch (err) {
      statusEl.textContent = `Failed to build export: ${err?.message || String(err)}`;
      modalManager.open();
    }
  }

  downloadBtn.addEventListener('click', () => {
    try {
      const json = currentJson || JSON.stringify((typeof buildPayload === 'function') ? buildPayload() : {}, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (typeof getFilename === 'function') ? getFilename() : 'annotation_set.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      statusEl.textContent = 'Download started';
    } catch (err) {
      statusEl.textContent = `Download failed: ${err?.message || String(err)}`;
    }
  });

  copyBtn.addEventListener('click', async () => {
    try {
      const json = currentJson || JSON.stringify((typeof buildPayload === 'function') ? buildPayload() : {}, null, 2);
      // Prefer modern clipboard API
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(json);
      } else {
        // Fallback for browsers/contexts without navigator.clipboard
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('execCommand copy failed');
      }
      statusEl.textContent = 'Copied';
      setTimeout(() => { statusEl.textContent = ''; }, 900);
    } catch (err) {
      console.error('Copy to clipboard failed', err);
      statusEl.textContent = 'Copy failed: ' + (err?.message || String(err));
      setTimeout(() => { statusEl.textContent = ''; }, 2400);
    }
  });

  uploadBtn.addEventListener('click', async () => {
    uploadBtn.disabled = true;
    statusEl.textContent = 'Uploading…';
    try {
      const result = await (typeof upload === 'function' ? upload() : Promise.resolve({ ok: false, message: 'No upload handler' }));
      if (result && result.ok) {
        statusEl.textContent = result.message || 'Upload successful';
      } else {
        const msgs = [result?.message, ...(result?.errors || [])].filter(Boolean).join('; ');
        statusEl.textContent = `Upload failed: ${msgs}`;
      }
    } catch (err) {
      statusEl.textContent = err?.message || 'Upload failed';
    } finally {
      try { uploadBtn.disabled = !getApiKey(); } catch (e) {}
    }
  });

  function setUploadEnabled(enabled) {
    try { uploadBtn.disabled = !enabled; } catch (e) {}
  }

  return { open, setUploadEnabled };
}

export default createXcExportModal;
