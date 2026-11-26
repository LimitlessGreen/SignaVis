# @signavis/sun-charts

Sun altitude, twilight phases and day length for any place and date, plus small SVG charts
and dials that show where a moment (or a recording) sits in the day and in the year.
Extracted from [SignaVis](https://github.com/LimitlessGreen/SignaVis), where it shows the
light context of a recording – many animals time their activity by light.

- **Core** (`@signavis/sun-charts/core`): no DOM. Sun altitude, sunrise/sunset and civil,
  nautical and astronomical twilight, day length, seasons, time zone and UTC offset for a place
  (via `@photostructure/tz-lookup`). Accurate to a few minutes between the polar circles.
- **Moon** (also in `core`): moon altitude, moonrise/moonset and phase (lit fraction, waxing or
  waning, eight named phases). Low precision: about a degree in altitude, a few minutes for
  rise/set (more near the polar circles); checked against PyEphem in `tests/moon.test.mjs`.
- **Charts** (`@signavis/sun-charts`): linear charts (default) or astronomical dials, with a
  zone picker and a strip of the light phases a long recording passes through.

## Install

```sh
npm install @signavis/sun-charts
```

## Use

```js
import { SunCharts } from '@signavis/sun-charts';
import '@signavis/sun-charts/style.css';

const charts = new SunCharts();
document.body.append(
    // place, date (YYYY-MM-DD), local clock time (HH:MM or null), duration in seconds
    charts.render({ lat: 51.34, lon: 12.37 }, '2026-06-21', '04:10', 3 * 3600),
);
```

Call `render()` again when place, date or time change; it re-uses the same element and hides it
when date or place is missing.

The chart/dial choice is kept in `localStorage` by default. Pass your own storage
(`{ get(key), set(key, value) }`) and key if you like:

```js
new SunCharts({ storage: myPrefs, storageKey: 'myapp.lightView' });
```

### Moon

The day dial can show the moon too (off by default): its altitude over the day as a dashed
curve, ticks at moonrise and moonset, and a disc in the current phase at the recording time
(or where the moon stands highest when no time is given). North of the equator a waxing moon
is lit on the right, south of it on the left.

```js
new SunCharts({ moon: true });
buildDayDial(place, '2026-11-24', '22:00', 1, 0, { moon: true });
```

Only the calculations:

```js
import { sunDay, guessUtcOffset, moonIllumination, moonEvents } from '@signavis/sun-charts/core';

const off = guessUtcOffset(52.52, 13.405, '2024-06-21');   // 2 (CEST)
const day = sunDay(52.52, 13.405, '2024-06-21', off);
day.events.horizon;      // { rise: 282.7, set: 1293.0 } – minutes after local midnight
day.events.astronomical; // 'always-above' – no astronomical night at midsummer

moonIllumination('2024-06-21', 720, off); // { fraction: 0.99, phase: 0.47, waxing: true, name: 'full moon' }
moonEvents(52.52, 13.405, '2024-06-21', off); // [{ kind: 'set', minutes: 186.5 }, { kind: 'rise', minutes: 1325.2 }]
```

## Options

All options are optional. `SunCharts` takes them in the constructor; `update(options)` changes
them later and redraws (e.g. after a language switch).

```js
const charts = new SunCharts({
    labels: 'de',            // 'en' (default), 'de', or your own (partial) label set
    clock: '12h',            // '24h' (default) or '12h'
    colors: { phases: { civil: '#7f8fd0' }, seasons: { summer: '#ff8c42' } },
    moon: true,              // moon in the day dial
    view: 'dial',            // default view when nothing is stored; fixed view without switch
    show: {                  // parts, all true by default
        title: true, viewSwitch: true, zone: true,
        day: true, year: true, spans: true, events: true,
    },
    storage: myPrefs,        // { get(key), set(key, value) }; default localStorage
    storageKey: 'myapp.lightView',
    onViewChange: (view) => {},
    onZoneChange: ({ utcOffset, effective, coords, date }) => {},
});
```

**Texts.** `LABELS_EN` and `LABELS_DE` are exported. For another language pass an object; missing
keys fall back to English. Some labels are functions (`daylight(duration)`,
`relToSunEvent(duration, before, event)`, …) so word order can follow the language:

```js
import { LABELS_EN } from '@signavis/sun-charts';
new SunCharts({ labels: { ...LABELS_EN, title: 'Daylight', dawn: 'Morning', dusk: 'Evening' } });
```

**Clock zone.** The picker defaults to the local time at the place (with summer time). When the
user picks another zone, `onZoneChange` reports it; `utcOffset` is `null` when they went back to
local time. Pass a saved offset as the fifth argument of `render()`:

```js
charts.render(place, date, time, durationSec, savedOffset ?? null);
```

**Single charts.** `buildDayChart`, `buildYearChart`, `buildDayDial` and `buildYearDial` take the
same `labels`, `clock` and `colors` options (the day builders also `moon`/`events`).

## Styling

Colours of the light phases and seasons are CSS custom properties with the configured colour as
fallback, so a theme can change them without code: `--sun-phase-night`, `-astronomical`,
`-nautical`, `-civil`, `-golden`, `-day`; `--sun-season-winter`, `-spring`, `-summer`, `-autumn`.
Marks: `--sun-color-sun`, `--sun-color-sun-disc`, `--sun-color-daylight`, `--sun-color-line`,
`--sun-color-span`, `--sun-color-sky`, `--sun-color-sky-night`, `--sun-color-earth`,
`--sun-color-moon`, `--sun-color-moon-lit`.

The surroundings use `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`,
`--color-border`, `--color-bg-surface`, `--color-accent` (each with a light-theme fallback). Set
them on a parent for a dark theme.

## Develop

```sh
npm test                 # node --test, no browser needed
npm run build            # dist/ (ES modules + .d.ts + CSS)
npx vite . --port 5233   # demo at /demo/
```

## License

AGPL-3.0-only, like SignaVis.
