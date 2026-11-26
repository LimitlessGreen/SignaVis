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

## Styling

The stylesheet uses these custom properties, each with a light-theme fallback:
`--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-border`,
`--color-bg-surface`, `--color-accent`. Set them on a parent for a dark theme.

## Develop

```sh
npm test                 # node --test, no browser needed
npm run build            # dist/ (ES modules + .d.ts + CSS)
npx vite . --port 5233   # demo at /demo/
```

## License

AGPL-3.0-only, like SignaVis.
