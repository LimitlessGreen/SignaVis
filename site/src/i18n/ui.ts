// Landing-page strings. Docs are translated as separate files under src/content/docs/<lang>/.
export const languages = { en: 'English', de: 'Deutsch' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'en';

/** Path prefix for a language, e.g. '' for English and '/de' for German. */
export const langPrefix = (lang: Lang) => (lang === defaultLang ? '' : `/${lang}`);

export const ui = {
  en: {
    metaTitle: 'SignaVis – Free spectrogram viewer & bird sound labeling',
    metaDesc: 'Free, open-source app for bioacoustics: view spectrograms, identify bird species with BirdNET, annotate calls and use Xeno-canto – in the browser, on mobile or as a desktop app.',
    navUseCases: 'Use cases', navFeatures: 'Features', navDocs: 'Docs', openApp: 'Open app',
    navShortUse: 'Use', navShortApp: 'App', themeToggle: 'Toggle light/dark',
    heroA: 'See', heroB: 'bird sounds.', heroAccentFirst: true,
    heroLede: 'Spectrogram analysis, species identification and annotation for bioacoustic recordings. In the browser, on mobile and on the desktop.',
    ctaStart: 'Start in browser', ctaGuide: 'Guide',
    trustLocal: 'Local processing by default', trustOss: 'Open source',
    useCasesTitle: 'Use cases',
    useCases: [
      ['audio-lines', 'Analyse a recording', 'Identify the species present with BirdNET.', '/docs/use-cases/listen/'],
      ['tag', 'Annotate calls', 'Mark calls in time and frequency.', '/docs/use-cases/label-calls/'],
      ['smartphone', 'Mobile review', 'Inspect recordings in the field.', '/docs/use-cases/mobile/'],
      ['list-checks', 'Regional species lists', 'Restrict results to species expected on site.', '/docs/use-cases/species-lists/'],
      ['scan-search', 'Similar-call search', 'Find all occurrences of a reference call.', '/docs/use-cases/similar-calls/'],
    ],
    featuresTitle: 'Features', more: 'More',
    features: [
      ['overview.mp4', 'Overview', 'Whole-recording overview', 'Activity across the entire recording, including multi-hour files.', '/docs/features/overview/'],
      ['labeling.mp4', 'Labeling', 'Fast annotation', 'Time–frequency boxes with species, sound type and keyboard shortcuts.', '/docs/features/labels/'],
      ['magnifier.mp4', 'Magnifier', 'Detail view', 'Inspect fine structure while keeping the context visible.', '/docs/features/magnifier/'],
    ],
    mobileKicker: 'Mobile', mobileTitle: 'Optimised for mobile devices',
    mobileText: 'Load Xeno-canto recordings, play them back and review the detected species.', mobileCta: 'Open mobile version',
    mobileAlt: 'SignaVis on a phone: spectrogram with detected species',
    desktopAlt: 'SignaVis on a computer: spectrogram of a Tree Pipit song',
    getBrowser: ['Web app', 'No installation required.'],
    getLite: ['SignaVis Lite', 'Desktop app for Windows, macOS and Linux. Works offline.'],
    getSponsor: ['Support', 'Sponsorship keeps SignaVis free and open.'],
    footerTag: 'Open-source software for bioacoustics.', footerSample: 'Sample recording', footerSupport: 'Support', footerCite: 'Cite',
  },
  de: {
    metaTitle: 'SignaVis – Kostenloser Spektrogramm-Viewer für Vogelstimmen',
    metaDesc: 'Kostenlose Open-Source-Software für Bioakustik: Spektrogramme analysieren, Vogelarten mit BirdNET bestimmen, Rufe annotieren, Xeno-canto nutzen – im Browser, mobil oder als Desktop-App.',
    navUseCases: 'Anwendungen', navFeatures: 'Funktionen', navDocs: 'Doku', openApp: 'App öffnen',
    navShortUse: 'Anwendung', navShortApp: 'App', themeToggle: 'Hell/Dunkel umschalten',
    heroA: 'Vogelstimmen', heroB: 'sehen.', heroAccentFirst: false,
    heroLede: 'Spektrogramm-Analyse, Artbestimmung und Annotation bioakustischer Aufnahmen. Im Browser, mobil und als Desktop-App.',
    ctaStart: 'Im Browser starten', ctaGuide: 'Dokumentation',
    trustLocal: 'Standardmäßig lokale Verarbeitung', trustOss: 'Open Source',
    useCasesTitle: 'Anwendungsfälle',
    useCases: [
      ['audio-lines', 'Aufnahme auswerten', 'Vorkommende Arten mit BirdNET bestimmen.', '/docs/use-cases/listen/'],
      ['tag', 'Rufe annotieren', 'Rufe in Zeit und Frequenz markieren.', '/docs/use-cases/label-calls/'],
      ['smartphone', 'Mobile Sichtung', 'Aufnahmen direkt im Feld prüfen.', '/docs/use-cases/mobile/'],
      ['list-checks', 'Regionale Artenlisten', 'Ergebnisse auf am Standort erwartete Arten begrenzen.', '/docs/use-cases/species-lists/'],
      ['scan-search', 'Suche nach ähnlichen Rufen', 'Alle Vorkommen eines Referenzrufs finden.', '/docs/use-cases/similar-calls/'],
    ],
    featuresTitle: 'Funktionen', more: 'Mehr',
    features: [
      ['overview.mp4', 'Überblick', 'Übersicht der gesamten Aufnahme', 'Aktivität über die volle Länge, auch bei mehrstündigen Dateien.', '/docs/features/overview/'],
      ['labeling.mp4', 'Annotation', 'Schnelle Annotation', 'Zeit-Frequenz-Rahmen mit Art, Lautäußerung und Tastenkürzeln.', '/docs/features/labels/'],
      ['magnifier.mp4', 'Lupe', 'Detailansicht', 'Feinstruktur prüfen, ohne den Kontext zu verlieren.', '/docs/features/magnifier/'],
    ],
    mobileKicker: 'Mobil', mobileTitle: 'Für Mobilgeräte optimiert',
    mobileText: 'Xeno-canto-Aufnahmen laden, abspielen und erkannte Arten prüfen.', mobileCta: 'Mobile Version öffnen',
    mobileAlt: 'SignaVis auf dem Smartphone: Spektrogramm mit erkannten Arten',
    desktopAlt: 'SignaVis am Computer: Spektrogramm eines Baumpieper-Gesangs',
    getBrowser: ['Web-App', 'Keine Installation erforderlich.'],
    getLite: ['SignaVis Lite', 'Desktop-App für Windows, macOS und Linux. Offline nutzbar.'],
    getSponsor: ['Unterstützen', 'Sponsoring hält SignaVis frei und offen.'],
    footerTag: 'Open-Source-Software für Bioakustik.', footerSample: 'Beispielaufnahme', footerSupport: 'Unterstützen', footerCite: 'Zitieren',
  },
} as const;
