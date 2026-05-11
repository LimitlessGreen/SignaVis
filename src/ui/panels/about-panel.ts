/**
 * About panel creator for the Labeling App
 * Returns an unattached DOM element which can be registered with the Sidebar.
 */
export function createAboutPanel() {
  const el = document.createElement('div');
  el.id = 'panelAbout';
  el.className = 'scroll-panel';
  el.hidden = true;
  el.innerHTML = `
    <div class="panel-actions" style="padding: 12px 14px;">
      <a class="sidebar-action-btn" href="https://github.com/LimitlessGreen/SignaVis" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
      <a class="sidebar-action-btn danger" href="https://github.com/LimitlessGreen/SignaVis/issues" target="_blank" rel="noopener noreferrer" aria-label="Report an issue">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM8 11.2a.9.9 0 110 1.8.9.9 0 010-1.8zM8 3.8a.7.7 0 01.7.7v4.2a.7.7 0 11-1.4 0V4.5c0-.39.31-.7.7-.7z" fill="#fff"/></svg>
        Report an issue
      </a>
    </div>
    <div class="help-content">
      <div class="help-section">
        <h3>About</h3>
        <p>Repository: <a href="https://github.com/LimitlessGreen/SignaVis" target="_blank" rel="noopener noreferrer">github.com/LimitlessGreen/SignaVis</a></p>
        <p>Project: signavis</p>
        <p>Author: LimitlessGreen</p>
        <p>License: AGPL-3.0-only</p>

        <h4>Special thanks</h4>
        <p>Special thanks to the BirdNET authors for the model and excellent work. Additional inspiration taken from <a href="https://github.com/nishantnnb/spectrolipi" target="_blank" rel="noopener noreferrer">spectrolipi</a>.</p>

        <h4>BirdNET</h4>
        <p>BirdNET model and tools — see <a href="https://github.com/birdnet-team/BirdNET-Analyzer" target="_blank" rel="noopener noreferrer">BirdNET-Analyzer</a> for models and resources.</p>
        <p>If you use BirdNET in research, please cite:</p>
        <p style="margin-top:6px">Kahl, S., Wood, C. M., Eibl, M., &amp; Klinck, H. (2021). BirdNET: A deep learning solution for avian diversity monitoring. <em>Ecological Informatics</em>, 61, 101236.</p>
        <details class="bibtex-collapsible">
          <summary>BibTeX</summary>
          <pre class="bibtex">@article{kahl2021birdnet,
  title={BirdNET: A deep learning solution for avian diversity monitoring},
  author={Kahl, Stefan and Wood, Connor M and Eibl, Maximilian and Klinck, Holger},
  journal={Ecological Informatics},
  volume={61},
  pages={101236},
  year={2021},
  publisher={Elsevier}
}</pre>
        </details>

        <h4>Dependencies</h4>
        <ul>
          <li>jsoneditor</li>
        </ul>

        <h4>Peer Dependencies</h4>
        <ul>
          <li>wavesurfer.js (optional)</li>
        </ul>

        <h4>Dev Dependencies</h4>
        <ul>
          <li>lucide-static</li>
          <li>sass</li>
          <li>typescript</li>
          <li>vite</li>
          <li>wavesurfer.js</li>
        </ul>

      </div>
    </div>
  `;
  return el;
}
