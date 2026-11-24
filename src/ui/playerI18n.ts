// Language of the player's own UI (option `locale`). The UI is written in
// English; another language is a dictionary from the English text to the
// translation, applied to the player's DOM and to everything written into it
// later. Text without an entry stays English, so a missing translation shows
// the English original rather than a key.

type Patterns = [RegExp, (...groups: string[]) => string][];
interface Translation { text: Record<string, string>; patterns: Patterns }

const de: Translation = {
    text: {
        // Transport and toolbar
        'Load audio file': 'Audiodatei laden',
        'Jump to start (Home)': 'Zum Anfang (Pos1)',
        'Jump to end (End)': 'Zum Ende (Ende)',
        '-5s (J)': '−5 s (J)',
        '+5s (L)': '+5 s (L)',
        'Play / Pause (Space)': 'Abspielen / Pause (Leertaste)',
        'Stop': 'Stopp',
        'Show more controls': 'Weitere Bedienelemente',
        'More': 'Mehr',
        'Mute / Unmute': 'Stumm / Ton an',
        'Volume': 'Lautstärke',
        'Norm': 'Norm',
        'Listening mode for ultrasound: slow down (pitch drops along, ×10 makes bat calls audible), or a heterodyne / frequency-division detector':
            'Hörmodus für Ultraschall: verlangsamen (die Tonhöhe sinkt mit, ×10 macht Fledermausrufe hörbar) oder ein Mischer-/Frequenzteiler-Detektor',
        'Pitch ÷': 'Tonhöhe ÷',
        'Heterodyne': 'Mischer',
        'Freq. division': 'Frequenzteiler',
        'View: follow, loop, crosshair, fit, reset': 'Ansicht: folgen, Schleife, Fadenkreuz, einpassen, zurücksetzen',
        'View options': 'Ansichtsoptionen',
        'Follow': 'Folgen',
        'Free': 'Frei',
        'Smooth': 'Gleitend',
        'Follow playhead': 'Wiedergabeposition folgen',
        'Free navigation': 'Freie Navigation',
        'Smooth follow (continuous)': 'Gleitend folgen (fortlaufend)',
        'Toggle Free / Follow / Smooth': 'Frei / Folgen / Gleitend umschalten',
        'Loop': 'Schleife',
        'Loop On': 'Schleife an',
        'Crosshair': 'Fadenkreuz',
        'Toggle crosshair': 'Fadenkreuz ein/aus',
        'Fit': 'Einpassen',
        'Fit: show the whole recording (time only)': 'Einpassen: ganze Aufnahme zeigen (nur Zeit)',
        'Reset': 'Zurücksetzen',
        'Reset: default time zoom, back to the start, full frequency range':
            'Zurücksetzen: Standard-Zeitzoom, zurück zum Anfang, voller Frequenzbereich',
        'Zoom': 'Zoom',
        'Time zoom': 'Zeitzoom',
        'Frequency zoom': 'Frequenzzoom',
        'Time zoom (horizontal) — also Ctrl + scroll': 'Zeitzoom (horizontal) – auch Strg + Mausrad',
        'Frequency zoom (vertical) — also Shift + scroll, or scroll over the frequency axis':
            'Frequenzzoom (vertikal) – auch Umschalt + Mausrad oder Mausrad über der Frequenzachse',
        'Show more time': 'Mehr Zeit zeigen',
        'Show less time (zoom in)': 'Weniger Zeit zeigen (hineinzoomen)',
        'Show a wider frequency range': 'Breiteren Frequenzbereich zeigen',
        'Show a narrower frequency range (zoom in)': 'Schmaleren Frequenzbereich zeigen (hineinzoomen)',
        'Fit the frequency range to where the calls are': 'Frequenzbereich an die Rufe anpassen',
        'Visible frequency range': 'Sichtbarer Frequenzbereich',
        'Time': 'Zeit',
        'Freq': 'Freq.',
        'Playback position': 'Wiedergabeposition',
        'Spectrogram contrast': 'Spektrogramm-Kontrast',
        'Floor': 'Boden',
        'Range': 'Umfang',
        'Black level in dB above the noise floor': 'Schwarzwert in dB über dem Grundrauschen',
        'Dynamic range in dB from black to white': 'Dynamikumfang in dB von Schwarz bis Weiß',
        'Fit floor and range to the visible part of the spectrogram':
            'Boden und Umfang an den sichtbaren Teil des Spektrogramms anpassen',
        'Draw': 'Zeichnen',
        'Draw mode: drag on the spectrogram to draw a label (Shift+Drag always draws)':
            'Zeichenmodus: im Spektrogramm ziehen, um ein Label zu zeichnen (Umschalt+Ziehen zeichnet immer)',
        'Stamp': 'Stempel',
        'Stamp mode (Ctrl+D)': 'Stempelmodus (Strg+D)',
        'Snap': 'Fangen',
        'Snap to call: click a call to box it — BirdBox call box if there is one, else from the signal (Shift+wheel = confidence / sensitivity, click/Enter = add, Alt = ask for the name, Esc = cancel)':
            'Ruf fangen: einen Ruf anklicken, um ihn einzurahmen – mit der BirdBox-Box, falls vorhanden, sonst aus dem Signal (Umschalt+Mausrad = Konfidenz / Empfindlichkeit, Klick/Eingabe = hinzufügen, Alt = nach dem Namen fragen, Esc = abbrechen)',
        'Magnifier: drag a field to zoom into it (right-click = back, Esc = leave)':
            'Lupe: einen Bereich aufziehen, um hineinzuzoomen (Rechtsklick = zurück, Esc = beenden)',

        // Settings panel
        'Settings': 'Einstellungen',
        'Open settings panel': 'Einstellungen öffnen',
        'Close': 'Schließen',
        'Preset': 'Voreinstellung',
        'Set as default preset': 'Als Standard festlegen',
        'Save current settings as preset': 'Aktuelle Einstellungen als Voreinstellung speichern',
        'Manage presets': 'Voreinstellungen verwalten',
        'Preset name…': 'Name der Voreinstellung …',
        'Save': 'Speichern',
        'Cancel': 'Abbrechen',
        'Import': 'Importieren',
        'Export': 'Exportieren',
        'Import presets from JSON': 'Voreinstellungen aus JSON importieren',
        'Export user presets as JSON': 'Eigene Voreinstellungen als JSON exportieren',
        'Custom': 'Eigene',
        '— Custom —': '— Eigene —',
        'Classic': 'Klassisch',
        'Classic small': 'Klassisch klein',
        'Balanced': 'Ausgewogen',
        'Time ↔ Frequency': 'Zeit ↔ Frequenz',
        'Window length: short windows show fast song sharply in time, long windows separate close frequencies':
            'Fensterlänge: kurze Fenster zeigen schnellen Gesang zeitlich scharf, lange trennen nahe Frequenzen',
        'Display': 'Darstellung',
        'Mode': 'Modus',
        'Auto': 'Auto',
        'Fixed': 'Fest',
        'Auto: percentile-based contrast on each file. Fixed: use saved floor/ceil values.':
            'Auto: Kontrast je Datei aus Perzentilen. Fest: gespeicherte Boden-/Deckenwerte verwenden.',
        'Spectrogram floor': 'Spektrogramm-Boden',
        'Spectrogram ceiling': 'Spektrogramm-Decke',
        'Auto Contrast': 'Auto-Kontrast',
        'Auto optimize contrast': 'Kontrast automatisch optimieren',
        'Adaptive Contrast': 'Adaptiver Kontrast',
        'Channel': 'Kanal',
        'Channels shown and analysed. Playback keeps all channels.':
            'Angezeigte und analysierte Kanäle. Die Wiedergabe behält alle Kanäle.',
        'Channels shown and analysed (playback keeps all channels)':
            'Angezeigte und analysierte Kanäle (die Wiedergabe behält alle Kanäle)',
        'Max Freq': 'Max. Freq.',
        'Auto: detect from content. Nyquist: full bandwidth. Fixed: use selected value.':
            'Auto: aus dem Inhalt erkennen. Nyquist: volle Bandbreite. Fest: gewählten Wert verwenden.',
        'Auto-detect frequency range': 'Frequenzbereich automatisch erkennen',
        'Frequency': 'Frequenz',
        'Linear': 'Linear',
        'Log frequency': 'Log. Frequenz',
        'Noise Reduction': 'Rauschminderung',
        'Median-based spectral noise floor subtraction': 'Abzug des spektralen Grundrauschens (Median)',
        'Loupe': 'Lupe',
        'Loupe Detail': 'Lupen-Detail',
        'Magnified view: next to the pointer while moving or resizing a label (hold Shift for fine 1/4-speed dragging), or in a movable window that follows the pointer':
            'Vergrößerte Ansicht: neben dem Zeiger beim Verschieben oder Ändern eines Labels (Umschalt halten für feines Ziehen mit 1/4 Tempo) oder in einem beweglichen Fenster, das dem Zeiger folgt',
        'Loupe computes its own fine spectrogram (Hann ~11.6 ms) instead of magnifying the display pixels':
            'Die Lupe berechnet ein eigenes feines Spektrogramm (Hann ~11,6 ms), statt die Anzeigepixel zu vergrößern',
        'At pointer': 'Am Zeiger',
        'Never': 'Nie',
        'Off': 'Aus',
        'None': 'Keine',
        'Overlay': 'Überlagerung',
        'Compact labels from': 'Kompakte Labels ab',
        "With many overlapping labels (e.g. BirdNET's 3 s windows), unselected ones shrink to thin strokes from this many stacked rows; hover or select one to see its name":
            'Bei vielen überlappenden Labels (z. B. BirdNETs 3-s-Fenstern) schrumpfen nicht ausgewählte ab so vielen gestapelten Zeilen zu dünnen Strichen; zum Lesen des Namens darüberfahren oder auswählen',
        'Contrast Limited Adaptive Histogram Equalization — enhances local detail':
            'Kontrastbegrenzter adaptiver Histogrammausgleich – hebt lokale Details hervor',
        'Spectral Centroid': 'Spektraler Schwerpunkt',
        'Weighted mean frequency of the magnitude spectrum per frame':
            'Gewichtete mittlere Frequenz des Betragsspektrums je Frame',
        'Cepstral Pitch (F0)': 'Grundton per Cepstrum (F0)',
        'Fundamental frequency (F0) estimated via cepstral analysis':
            'Grundfrequenz (F0), per Cepstrum-Analyse geschätzt',
        'Spectral Ridges': 'Spektrale Grate',
        'Spectral ridges: continuous frequency tracks of local spectral maxima (harmonics and tonal components)':
            'Spektrale Grate: durchgehende Frequenzspuren lokaler Maxima (Obertöne und tonale Anteile)',
        'Colour Scale': 'Farbskala',
        'Color': 'Farbe',
        'Phase': 'Phase',
        'Phase angle per bin: looks like noise on most recordings; only useful for analysing tonal/phase structure':
            'Phasenwinkel je Bin: sieht bei den meisten Aufnahmen wie Rauschen aus; nur zur Analyse tonaler/Phasenstruktur nützlich',
        'Window': 'Fenster',
        'Window Size (samples)': 'Fenstergröße (Samples)',
        'Window Fn': 'Fensterfkt.',
        'Window Function': 'Fensterfunktion',
        'Time-frequency reassignment sharpens spectral peaks': 'Zeit-Frequenz-Reassignment schärft spektrale Spitzen',
        'Reassigned': 'Reassigned',
        'Overlap': 'Überlappung',
        'Window Overlap — higher = smoother time axis': 'Fensterüberlappung – höher = glattere Zeitachse',
        'Oversampling': 'Überabtastung',
        'Zero-pad FFT — higher = finer frequency resolution': 'FFT mit Nullen auffüllen – höher = feinere Frequenzauflösung',
        'Mel Bins': 'Mel-Bänder',
        'Number of mel bands': 'Anzahl der Mel-Bänder',
        'Gain': 'Verstärkung',
        'Bias': 'Bias',
        'Root': 'Wurzel',
        'Time constant (s)': 'Zeitkonstante (s)',
        'Smoother time constant in seconds (independent of hop size)':
            'Zeitkonstante der Glättung in Sekunden (unabhängig von der Schrittweite)',

        // Views, overview, status bar
        'Adjust amplitude/spectrogram ratio': 'Verhältnis Wellenform/Spektrogramm anpassen',
        'Adjust spectrogram height': 'Spektrogrammhöhe anpassen',
        'Reset vertical zoom (Shift+DblClick)': 'Vertikalen Zoom zurücksetzen (Umschalt+Doppelklick)',
        'Drag to move the view': 'Ziehen, um die Ansicht zu verschieben',
        'Drag to resize the table': 'Ziehen, um die Tabellenhöhe zu ändern',
        'Labels': 'Labels',
        'Toggle label overview': 'Label-Übersicht ein-/ausklappen',
        'Tracks': 'Spuren',
        'Label tracks along the timeline': 'Label-Spuren entlang der Zeitachse',
        'Table': 'Tabelle',
        'Editable label table': 'Bearbeitbare Label-Tabelle',
        'Open': 'Öffnen',
        'No file': 'Keine Datei',
        'Loading…': 'Lädt …',
        'Loading audio…': 'Audio wird geladen …',
        'Decoding audio…': 'Audio wird dekodiert …',
        'Computing spectrogram…': 'Spektrogramm wird berechnet …',
        '· Spectrogram unavailable': '· Spektrogramm nicht verfügbar',
        'This recording is too long to compute its spectrogram in memory, and the browser has no storage space left for spectrogram tiles (e.g. in a private window). Use a normal window or free up disk space, then reload the file.':
            'Diese Aufnahme ist zu lang, um ihr Spektrogramm im Arbeitsspeicher zu berechnen, und der Browser hat keinen Speicherplatz mehr für Spektrogramm-Kacheln (z. B. in einem privaten Fenster). Ein normales Fenster verwenden oder Speicherplatz freigeben und die Datei neu laden.',
        'Idle': 'Bereit',
        'Loading': 'Lädt',
        'Ready': 'Bereit',
        'Rendering...': 'Wird gezeichnet …',
        'Playing': 'Wiedergabe',
        'Playing (Loop)': 'Wiedergabe (Schleife)',
        'Playing (Segment)': 'Wiedergabe (Abschnitt)',
        'Paused': 'Pausiert',
        'Paused (Segment)': 'Pausiert (Abschnitt)',
        'Stopped': 'Gestoppt',
        'Error': 'Fehler',
    },
    patterns: [
        [/^(\d+) rows$/, (n) => `${n} Zeilen`],
        [/^Visible time span \((.+) px\/s\)$/, (pps) => `Sichtbare Zeitspanne (${pps} px/s)`],
        [/^Normalize playback to -1 dBFS peak \(max \+40 dB\)( - this file: (.+) dB)?$/,
            (file, db) => `Wiedergabe auf −1 dBFS Spitze normalisieren (max. +40 dB)${file ? ` – diese Datei: ${db} dB` : ''}`],
        [/^(.*) \[read-only\]$/, (rest) => `${rest} [schreibgeschützt]`],
    ],
};

const TRANSLATIONS: Record<string, Translation> = { de };

/** The translation for a locale such as "de", "de-DE" or "de_AT"; null for English or one without a dictionary. */
export function translationFor(locale: unknown): Translation | null {
    const lang = String(locale || '').toLowerCase().split(/[-_]/)[0];
    return TRANSLATIONS[lang] ?? null;
}

/** `text` in the language of `tr`, or null when there is no translation for it. */
export function translateText(tr: Translation, text: string): string | null {
    const key = text.trim();
    if (!key) return null;
    let out = tr.text[key];
    if (out == null) {
        for (const [re, fn] of tr.patterns) {
            const m = re.exec(key);
            if (m) { out = fn(...m.slice(1)); break; }
        }
    }
    if (out == null || out === key) return null;
    return text.replace(key, out);
}

const ATTRS = ['title', 'aria-label', 'placeholder'];
// Label names are data, not UI text (attributes are still
// translated: a label's tooltip ends in UI text).
const SKIP = '.spectrogram-label-region, .annotation-region, .overview-label-row-name, [data-aw="fileInfo"] .statusbar-label';

function translateNode(tr: Translation, node: Node) {
    if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP)) return;
        const next = translateText(tr, node.textContent || '');
        if (next != null) node.textContent = next;
        return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    for (const a of ATTRS) {
        const v = el.getAttribute(a);
        const next = v && translateText(tr, v);
        if (next != null && next !== v) el.setAttribute(a, next);
    }
}

function translateTree(tr: Translation, root: Node) {
    translateNode(tr, root);
    const doc = root.ownerDocument || (root as Document);
    const walker = doc.createTreeWalker(root, 1 | 4);   // elements and text
    for (let n = walker.nextNode(); n; n = walker.nextNode()) translateNode(tr, n);
}

/**
 * Translates the player UI under `root` into `locale` and keeps translating
 * what is written into it later. Returns the function that stops it.
 */
export function installPlayerTranslation(root: HTMLElement, locale: unknown): () => void {
    const tr = translationFor(locale);
    if (!tr || typeof MutationObserver === 'undefined') return () => {};
    translateTree(tr, root);
    const observer = new MutationObserver((records) => {
        for (const r of records) {
            if (r.type === 'childList') r.addedNodes.forEach((n) => translateTree(tr, n));
            else translateNode(tr, r.target);
        }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    return () => observer.disconnect();
}
