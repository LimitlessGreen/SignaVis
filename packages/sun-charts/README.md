# @signavis/sun-charts

Sun altitude, twilight phases and day length for any place and date, plus small SVG charts
and dials that show where a moment (or a recording) sits in the day and in the year.
Extracted from [SignaVis](https://github.com/LimitlessGreen/SignaVis), where it shows the
light context of a recording – many animals time their activity by light.

- **Core** (`@signavis/sun-charts/core`): no DOM. Sun altitude, sunrise/sunset and civil,
  nautical and astronomical twilight, day length, seasons, time zone and UTC offset for a place
  (via `@photostructure/tz-lookup`). Accurate to a few minutes between the polar circles.
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

Only the calculations:

```js
import { sunDay, dayLengthHours, dayOfYear, guessUtcOffset } from '@signavis/sun-charts/core';

const off = guessUtcOffset(52.52, 13.405, '2024-06-21');   // 2 (CEST)
const day = sunDay(52.52, 13.405, '2024-06-21', off);
day.events.horizon;      // { rise: 282.7, set: 1293.0 } – minutes after local midnight
day.events.astronomical; // 'always-above' – no astronomical night at midsummer
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
