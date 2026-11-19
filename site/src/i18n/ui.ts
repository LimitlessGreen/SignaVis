// Landing-page strings. Docs are translated as separate files under src/content/docs/<lang>/.
export const languages = { en: 'English', de: 'Deutsch' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'en';

/** Path prefix for a language, e.g. '' for English and '/de' for German. */
export const langPrefix = (lang: Lang) => (lang === defaultLang ? '' : `/${lang}`);

export const ui = {
  en: {
    metaTitle: 'SignaVis – See bird sounds',
    metaDesc: 'Free, open-source app for bioacoustics: spectrograms, species detection and call labeling – in the browser, on your phone or as a desktop app.',
    navUseCases: 'Use cases', navFeatures: 'Features', navDocs: 'Docs', openApp: 'Open app',
    navShortUse: 'Use', navShortApp: 'App', themeToggle: 'Toggle light/dark',
    heroA: 'See', heroB: 'bird sounds.', heroAccentFirst: true,
    heroLede: 'In the browser, on your phone or as an app. Free.',
    ctaStart: 'Start in browser', ctaGuide: 'Guide',
    trustLocal: 'Stays on your device', trustOss: 'Open source',
    useCasesTitle: 'What do you want to do?',
    useCases: [
      ['audio-lines', 'Listen through a recording', 'Who is singing?', '/docs/use-cases/listen/'],
      ['tag', 'Label calls', 'Box calls and name them.', '/docs/use-cases/label-calls/'],
      ['search', 'Find a rare species', 'In hours of audio.', ''],
      ['smartphone', 'Review on the go', 'Record and check on your phone.', ''],
      ['list-checks', 'Your own species list', 'Only species found where you are.', ''],
      ['scan-search', 'Find similar calls', 'Pick one call, see all matches.', ''],
    ],
    featuresTitle: 'Features', more: 'More',
    features: [
      ['overview.mp4', 'Overview', 'Everything at a glance', 'See where things happen – even in hours of audio.', ''],
      ['labeling.mp4', 'Labeling', 'Label in seconds', 'Draw a box, type the species, done.', '/docs/features/labels/'],
      ['magnifier.mp4', 'Magnifier', 'Zoom into the detail', 'Fine detail without losing the overview.', ''],
    ],
    mobileKicker: 'On your phone', mobileTitle: 'Works on your phone too',
    mobileText: 'Record, detect species, confirm with one tap.', mobileCta: 'Open on phone',
    mobileAlt: 'SignaVis on a phone: reviewing detected species',
    desktopAlt: 'SignaVis on a computer: spectrogram of a Tree Pipit song',
    getBrowser: ['In the browser', 'No installation.'],
    getLite: ['SignaVis Lite', 'Windows, macOS, Linux. Offline.'],
    getSponsor: ['Support', 'Keep SignaVis free.'],
    footerTag: 'Open source for bioacoustics.', footerSample: 'Sample recording', footerSupport: 'Support',
  },
  de: {
    metaTitle: 'SignaVis – Vogelstimmen sehen',
    metaDesc: 'Kostenlose Open-Source-App für Bioakustik: Spektrogramme, Arterkennung und Rufe markieren – im Browser, am Handy oder als Desktop-App.',
    navUseCases: 'Anwendungen', navFeatures: 'Funktionen', navDocs: 'Doku', openApp: 'App öffnen',
    navShortUse: 'Anwenden', navShortApp: 'App', themeToggle: 'Hell/Dunkel umschalten',
    heroA: 'Vogelstimmen', heroB: 'sehen.', heroAccentFirst: false,
    heroLede: 'Im Browser, am Handy oder als App. Kostenlos.',
    ctaStart: 'Im Browser starten', ctaGuide: 'Anleitung',
    trustLocal: 'Bleibt auf deinem Gerät', trustOss: 'Open Source',
    useCasesTitle: 'Was willst du tun?',
    useCases: [
      ['audio-lines', 'Aufnahme durchhören', 'Wer singt da?', '/docs/use-cases/listen/'],
      ['tag', 'Rufe markieren', 'Rufe einrahmen und benennen.', '/docs/use-cases/label-calls/'],
      ['search', 'Seltene Art suchen', 'In Stunden von Material.', ''],
      ['smartphone', 'Unterwegs sichten', 'Aufnehmen und prüfen am Handy.', ''],
      ['list-checks', 'Eigene Artenliste', 'Nur Arten, die bei dir vorkommen.', ''],
      ['scan-search', 'Ähnliche Rufe finden', 'Einen Ruf wählen, alle Treffer sehen.', ''],
    ],
    featuresTitle: 'Funktionen', more: 'Mehr',
    features: [
      ['overview.mp4', 'Überblick', 'Alles auf einen Blick', 'Sofort sehen, wo etwas los ist – auch bei Stunden.', ''],
      ['labeling.mp4', 'Markieren', 'Markieren in Sekunden', 'Rahmen ziehen, Art tippen, fertig.', '/docs/features/labels/'],
      ['magnifier.mp4', 'Lupe', 'Ins Detail zoomen', 'Feine Details, ohne den Überblick zu verlieren.', ''],
    ],
    mobileKicker: 'Am Handy', mobileTitle: 'Auch am Handy',
    mobileText: 'Aufnehmen, Arten erkennen, mit einem Tipp bestätigen.', mobileCta: 'Am Handy öffnen',
    mobileAlt: 'SignaVis am Handy: erkannte Arten prüfen',
    desktopAlt: 'SignaVis am Computer: Spektrogramm eines Baumpieper-Gesangs',
    getBrowser: ['Im Browser', 'Ohne Installation.'],
    getLite: ['SignaVis Lite', 'Windows, macOS, Linux. Offline.'],
    getSponsor: ['Unterstützen', 'Damit SignaVis frei bleibt.'],
    footerTag: 'Open Source für Bioakustik.', footerSample: 'Beispielaufnahme', footerSupport: 'Unterstützen',
  },
} as const;
