/**
 * Strings of the phone UI (mobile-app.ts). English is the default and the fallback;
 * another language is one more dictionary with the same keys (missing keys fall back to English).
 *
 * Language: `?lang=de` in the URL, else localStorage `signavis.lang`, else English
 * (the desktop UI is English, so the phone follows it until there is a language setting).
 */

type Vars = Record<string, string | number>;
type Entry = string | ((v: Vars) => string);
type Dict = Record<string, Entry>;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const en = {
  'nav.recordings': 'Recordings',
  'nav.review': 'Review',
  'nav.player': 'Player',
  'nav.live': 'Live',
  'nav.species': 'Species',
  'nav.label': 'Navigation',

  'common.back': 'Back',
  'common.all': 'All',
  'common.undo': 'Undo',
  'common.unknown': 'Unknown',
  'common.noRecording': 'No recording',
  'common.labels': (v) => `${v.n} ${plural(+v.n, 'label', 'labels')}`,
  'source.own': 'My label',

  'rec.new': 'New',
  'rec.add': 'Add recording',
  'rec.empty': 'No recordings yet. Enter a Xeno-canto number above, or tap “New” for an audio file or the microphone.',
  'rec.species': (v) => `${v.n} species`,
  'rec.open': (v) => `${v.n} open`,
  'rec.reviewed': '✓ reviewed',
  'rec.notAnalysed': 'Not analysed',
  'rec.audioFile': 'Audio file',
  'date.today': 'today',
  'date.yesterday': 'yesterday',
  'new.file': 'Audio file',
  'new.fileHint': 'WAV, MP3, FLAC … from this device',
  'new.xc': 'Xeno-canto',
  'new.xcHint': 'Load a recording by its XC number',
  'new.xcPlaceholder': 'XC number or URL',
  'new.load': 'Load',
  'new.xcLoading': 'Loading from Xeno-canto …',
  'new.mic': 'Microphone',
  'new.micHint': 'Record live, BirdNET listens along',

  'queue.title': 'Review',
  'queue.summary': (v) => `${v.total} open ${plural(+v.total, 'detection', 'detections')} in ${v.recs} ${plural(+v.recs, 'recording', 'recordings')}${+v.done ? ` · ${v.done} done` : ''}`,
  'queue.allDone': 'All reviewed. ✓',
  'queue.nothing': 'Nothing to review yet. Analyse a recording under “Recordings”.',
  'queue.noRecs': 'No recordings yet. Open a file under “Recordings” or record with “Live”.',

  'rv.analyse': 'Analyse',
  'rv.rate': 'Playback speed',
  'rv.play': 'Play',
  'rv.pause': 'Pause',
  'rv.loop': 'Loop',
  'rv.loopLabel': 'Loop',
  'live.max': 'max',
  'rv.skipBack': (v) => `Back ${v.s} s`,
  'rv.skipFwd': (v) => `Forward ${v.s} s`,
  'rv.open': 'Open',
  'rv.species': (v) => `${v.n} ${plural(+v.n, 'species', 'species')}`,
  'rv.speciesHint': 'Tap a species to hear it; tap again to show all.',
  'rv.gestures': 'Pinch to zoom · drag to scroll · tap a detection to play it · double tap play/pause · hold to loop',
  'rv.noSpecies': 'No species detected yet.',
  'rv.analysing': 'Analysing …',
  'rv.detections': 'Detections',
  'rv.sub': (v) => `${v.det} ${plural(+v.det, 'detection', 'detections')} · ${v.open} open`,
  'rv.pickRecording': 'Pick a recording under “Recordings”.',
  'rv.noDetections': 'No detections yet.',
  'rv.noDetectionsAnalyse': 'No detections yet. Analyse with the button at the top right.',
  'rv.allDone': 'Everything in this recording is reviewed. ✓',
  'rv.confirmed': 'confirmed',
  'rv.discard': 'Discard',
  'rv.accept': 'Accept',
  'rv.unaccept': 'Confirmed – tap to undo',
  'rv.accepted': (v) => `✓ ${v.name} accepted`,
  'rv.unaccepted': 'Confirmation undone',
  'rv.discarded': (v) => `${v.name} discarded`,

  'sp.title': 'Species',
  'sp.search': 'Search species',
  'sp.confirmed': 'Confirmed',
  'sp.detected': 'Detected only',
  'sp.sortBy': 'Sorted by',
  'sp.sort.count': 'Count',
  'sp.sort.conf': 'Confidence',
  'sp.sort.name': 'Name',
  'sp.recs': (v) => `${v.n} ${plural(+v.n, 'recording', 'recordings')}`,
  'sp.noMatch': 'No species matches the filter.',
  'sp.empty': 'No species yet. Analyse a recording and the detected species show up here.',
  'sp.meta': (v) => `${v.det} detected · ${v.recs} rec.`,
  'sp.best': 'best example',
  'sp.more': (v) => `+ ${v.n} more`,
  'sp.playBest': (v) => `Play best example of ${v.name}`,

  'an.title': 'Analyse',
  'an.birdnet': 'Bird species (BirdNET)',
  'an.birdnetHint': 'Detects species in 3 s windows',
  'an.birdbox': 'Find single calls (BirdBox)',
  'an.birdboxHint': 'A box around each call, no species',
  'an.geo': 'Filter species by location',
  'an.geoNeedsModel': 'Needs the BirdNET range model',
  'an.noLocation': 'No location set',
  'an.minConf': 'Minimum confidence',
  'an.minConfHint': 'Lower = more detections, more to review',
  'an.expert': 'Expert options',
  'an.overlap': 'Window overlap',
  'an.merge': 'Merge overlapping detections',
  'an.desktopHint': 'Model and analysis backend are set in the desktop view.',
  'an.run': 'Start analysis',
  'an.running': (v) => `${v.job} running …`,
  'an.failed': 'Analysis could not start',
  'an.done': 'Done',

  'live.title': 'Live',
  'live.level': 'Level',
  'live.hint': 'Start recording – the spectrogram scrolls here from right to left.',
  'live.discard': 'Discard',
  'live.discardLabel': 'Discard recording',
  'live.start': 'Start recording',
  'live.stop': 'Stop and save',
  'live.every3s': 'BirdNET · every 3 s',
  'live.noneYet': 'No species detected yet …',
  'live.emptyHint': 'Detected species show up here while recording.',
  'live.unavailable': 'Live detection is not available here.',
  'live.justNow': 'just now',
  'live.agoS': (v) => `${v.n} s ago`,
  'live.agoMin': (v) => `${v.n} min ago`,
  'live.noMic': 'Microphone is not supported here.',
  'live.micDenied': 'No access to the microphone.',
  'live.mic': (v) => `Microphone: ${v.msg}`,
  'live.saved': 'Recording saved.',
  'live.discarded': 'Recording discarded.',
  'live.saving': 'Saving …',
  'live.savedAs': (v) => `Saved: ${v.name}`,
  'live.saveFailed': (v) => `Saving failed: ${v.msg}`,
  'live.geo': (v) => `BirdNET · location ${v.lat}, ${v.lon}`,
  'live.noGeo': 'BirdNET · no location filter',
} satisfies Dict;

export type MKey = keyof typeof en;

const de: Partial<Record<MKey, Entry>> = {
  'nav.recordings': 'Aufnahmen',
  'nav.review': 'Prüfen',
  'nav.player': 'Player',
  'nav.species': 'Arten',

  'common.back': 'Zurück',
  'common.all': 'Alle',
  'common.undo': 'Rückgängig',
  'common.unknown': 'Unbekannt',
  'common.noRecording': 'Keine Aufnahme',
  'common.labels': (v) => `${v.n} Labels`,
  'source.own': 'Eigenes Label',

  'rec.new': 'Neu',
  'rec.add': 'Aufnahme hinzufügen',
  'rec.empty': 'Noch keine Aufnahmen. Oben eine Xeno-canto-Nummer eingeben oder mit „Neu“ eine Audiodatei oder das Mikrofon wählen.',
  'rec.species': (v) => `${v.n} ${plural(+v.n, 'Art', 'Arten')}`,
  'rec.open': (v) => `${v.n} offen`,
  'rec.reviewed': '✓ geprüft',
  'rec.notAnalysed': 'Nicht analysiert',
  'rec.audioFile': 'Audiodatei',
  'date.today': 'heute',
  'date.yesterday': 'gestern',
  'new.file': 'Audiodatei',
  'new.fileHint': 'WAV, MP3, FLAC … vom Gerät',
  'new.xcHint': 'Aufnahme über die XC-Nummer laden',
  'new.xcPlaceholder': 'XC-Nummer oder URL',
  'new.load': 'Laden',
  'new.xcLoading': 'Lade von Xeno-canto …',
  'new.mic': 'Mikrofon',
  'new.micHint': 'Live aufnehmen, BirdNET hört mit',

  'queue.title': 'Prüfen',
  'queue.summary': (v) => `${v.total} offene Treffer in ${v.recs} ${plural(+v.recs, 'Aufnahme', 'Aufnahmen')}${+v.done ? ` · ${v.done} fertig` : ''}`,
  'queue.allDone': 'Alles geprüft. ✓',
  'queue.nothing': 'Noch nichts zu prüfen. Analysiere eine Aufnahme unter „Aufnahmen“.',
  'queue.noRecs': 'Noch keine Aufnahmen. Unter „Aufnahmen“ eine Datei öffnen oder mit „Live“ aufnehmen.',

  'rv.analyse': 'Analysieren',
  'rv.rate': 'Wiedergabetempo',
  'rv.play': 'Abspielen',
  'rv.loopLabel': 'Schleife',
  'rv.skipBack': (v) => `${v.s} s zurück`,
  'rv.species': (v) => `${v.n} ${plural(+v.n, 'Art', 'Arten')}`,
  'rv.speciesHint': 'Art antippen zum Anhören, nochmal tippen zeigt alle.',
  'rv.gestures': 'Zwei Finger zoomen · ziehen scrollt · Erkennung antippen spielt sie · Doppeltipp Start/Pause · halten = Schleife',
  'rv.noSpecies': 'Noch keine Arten erkannt.',
  'rv.analysing': 'Analysiere …',
  'rv.skipFwd': (v) => `${v.s} s vor`,
  'rv.open': 'Offen',
  'rv.detections': 'Erkennungen',
  'rv.sub': (v) => `${v.det} Treffer · ${v.open} offen`,
  'rv.pickRecording': 'Wähle unter „Aufnahmen“ eine Aufnahme aus.',
  'rv.noDetections': 'Noch keine Erkennungen.',
  'rv.noDetectionsAnalyse': 'Noch keine Erkennungen. Oben rechts analysieren.',
  'rv.allDone': 'Alles in dieser Aufnahme geprüft. ✓',
  'rv.confirmed': 'bestätigt',
  'rv.discard': 'Verwerfen',
  'rv.accept': 'Übernehmen',
  'rv.unaccept': 'Bestätigt – tippen zum Zurücknehmen',
  'rv.accepted': (v) => `✓ ${v.name} übernommen`,
  'rv.unaccepted': 'Bestätigung zurückgenommen',
  'rv.discarded': (v) => `${v.name} verworfen`,

  'sp.title': 'Arten',
  'sp.search': 'Art suchen',
  'sp.confirmed': 'Bestätigt',
  'sp.detected': 'Nur erkannt',
  'sp.sortBy': 'Sortiert nach',
  'sp.sort.count': 'Anzahl',
  'sp.sort.conf': 'Konfidenz',
  'sp.recs': (v) => `${v.n} ${plural(+v.n, 'Aufnahme', 'Aufnahmen')}`,
  'sp.noMatch': 'Keine Art passt zum Filter.',
  'sp.empty': 'Noch keine Arten. Analysiere eine Aufnahme, dann erscheinen die erkannten Arten hier.',
  'sp.meta': (v) => `${v.det} erkannt · ${v.recs} Aufn.`,
  'sp.best': 'bester Beleg',
  'sp.more': (v) => `+ ${v.n} weitere`,
  'sp.playBest': (v) => `Besten Beleg von ${v.name} abspielen`,

  'an.title': 'Analysieren',
  'an.birdnet': 'Vogelarten (BirdNET)',
  'an.birdnetHint': 'Erkennt Arten in 3-s-Fenstern',
  'an.birdbox': 'Rufe einzeln finden (BirdBox)',
  'an.birdboxHint': 'Box um jeden Ruf, ohne Art',
  'an.geo': 'Arten nach Ort filtern',
  'an.geoNeedsModel': 'Braucht das Gebietsmodell von BirdNET',
  'an.noLocation': 'Kein Ort gesetzt',
  'an.minConf': 'Mindest-Konfidenz',
  'an.minConfHint': 'Niedriger = mehr Treffer, mehr zu prüfen',
  'an.expert': 'Expertenoptionen',
  'an.overlap': 'Überlappung der Fenster',
  'an.merge': 'Überlappende Treffer zusammenfassen',
  'an.desktopHint': 'Modell und Analyse-Backend werden in der Desktop-Ansicht eingestellt.',
  'an.run': 'Analyse starten',
  'an.running': (v) => `${v.job} läuft …`,
  'an.failed': 'Analyse konnte nicht starten',
  'an.done': 'Fertig',

  'live.level': 'Pegel',
  'live.hint': 'Aufnahme starten – das Spektrogramm läuft hier von rechts nach links.',
  'live.discard': 'Verwerfen',
  'live.discardLabel': 'Aufnahme verwerfen',
  'live.start': 'Aufnahme starten',
  'live.stop': 'Stoppen und speichern',
  'live.every3s': 'BirdNET · alle 3 s',
  'live.noneYet': 'Noch keine Art erkannt …',
  'live.emptyHint': 'Erkannte Arten erscheinen hier, während aufgenommen wird.',
  'live.unavailable': 'Live-Erkennung ist hier nicht verfügbar.',
  'live.justNow': 'gerade eben',
  'live.agoS': (v) => `vor ${v.n} s`,
  'live.agoMin': (v) => `vor ${v.n} min`,
  'live.noMic': 'Mikrofon wird hier nicht unterstützt.',
  'live.micDenied': 'Kein Zugriff aufs Mikrofon.',
  'live.mic': (v) => `Mikrofon: ${v.msg}`,
  'live.saved': 'Aufnahme gespeichert.',
  'live.discarded': 'Aufnahme verworfen.',
  'live.saving': 'Wird gespeichert …',
  'live.savedAs': (v) => `Gespeichert: ${v.name}`,
  'live.saveFailed': (v) => `Speichern fehlgeschlagen: ${v.msg}`,
  'live.geo': (v) => `BirdNET · Ort ${v.lat}, ${v.lon}`,
  'live.noGeo': 'BirdNET · ohne Ortsfilter',
};

const DICTS: Record<string, Partial<Record<MKey, Entry>>> = { en, de };
/** Only real dictionaries (not inherited names such as "constructor"). */
const known = (l: string | null | undefined): l is string => !!l && Object.prototype.hasOwnProperty.call(DICTS, l);
export const LANGS = Object.keys(DICTS);
const STORE_KEY = 'signavis.lang';

function detectLang(): string {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (known(q)) return q;
    const s = localStorage.getItem(STORE_KEY);
    if (known(s)) return s;
  } catch { /* no window / storage */ }
  return 'en';
}

let lang = detectLang();

export function getLang() { return lang; }

/** Change the language (stored); the caller re-renders. */
export function setLang(next: string) {
  if (!known(next)) return;
  lang = next;
  try { localStorage.setItem(STORE_KEY, next); } catch { /* ignore */ }
}

export function t(key: MKey, vars: Vars = {}): string {
  const e = DICTS[lang]?.[key] ?? en[key];
  return typeof e === 'function' ? e(vars) : e;
}
