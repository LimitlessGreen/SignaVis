/**
 * Recording context block — date/time, location (one coordinate field + map) and device of the
 * active recording. Shows where each value comes from; typing overrides it, ↺ returns to auto.
 */

import {
    CONTEXT_SOURCE_TEXT, formatCoords, parseCoords,
    type ContextField, type ContextValues, type Coords, type ResolvedContext,
} from '../../app/recording-context.ts';
import { openMapModal } from '../components/geo-map-modal/geo-map-modal.ts';

const MINI_MAP_ZOOM = 10;
const TILE = 256;

export interface RecordingContextBlockOptions {
    el: HTMLElement;
    /** Store a manual override (null/'' clears it, falling back to the automatic source). */
    onChange: (field: ContextField, value: ContextValues[ContextField] | null) => void;
}

/** Static OSM tiles around a point, the point centred in a fixed-height strip. */
export function buildMiniMap(c: Coords, onClick: () => void) {
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'rc-minimap';
    wrap.title = 'Open map';
    const n = 2 ** MINI_MAP_ZOOM;
    const x = ((c.lon + 180) / 360) * n;
    const latRad = (c.lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const layer = document.createElement('div');
    layer.className = 'rc-minimap-tiles';
    // 3×3 tiles; the CSS centres the layer's point (tile centre + fractional offset) in the box
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.draggable = false;
            img.src = `https://tile.openstreetmap.org/${MINI_MAP_ZOOM}/${((tx + dx) % n + n) % n}/${ty + dy}.png`;
            img.style.left = `${(dx + 1) * TILE}px`;
            img.style.top = `${(dy + 1) * TILE}px`;
            layer.appendChild(img);
        }
    }
    layer.style.left = `calc(50% - ${(1 + x - tx) * TILE}px)`;
    layer.style.top = `calc(50% - ${(1 + y - ty) * TILE}px)`;
    wrap.appendChild(layer);
    const pin = document.createElement('span');
    pin.className = 'rc-minimap-pin';
    wrap.appendChild(pin);
    const attr = document.createElement('span');
    attr.className = 'rc-minimap-attr';
    attr.textContent = '© OpenStreetMap';
    wrap.appendChild(attr);
    wrap.addEventListener('click', onClick);
    return wrap;
}

export class RecordingContextBlock {
    el: HTMLElement;
    onChange: RecordingContextBlockOptions['onChange'];

    constructor(opts: RecordingContextBlockOptions) {
        this.el = opts.el;
        this.onChange = opts.onChange;
    }

    /** ctx null = no recording loaded. */
    render(ctx: ResolvedContext | null) {
        this.el.innerHTML = '';
        if (!ctx) return; // the surrounding section already says 'No recording loaded'

        const grid = document.createElement('div');
        grid.className = 'rc-grid';

        // Date + time share one row
        grid.appendChild(this._row('Date', [
            this._input('date', 'date', ctx.date.value ?? '', 'YYYY-MM-DD'),
            this._input('time', 'time', ctx.time.value ?? '', 'HH:MM'),
        ], ctx.date.source ?? ctx.time.source, ['date', 'time'].filter((f) => ctx[f as ContextField].source === 'manual') as ContextField[]));

        // Location: one field for "lat, lon" + locate + map
        const coords = ctx.coords.value as Coords | null;
        const coordInput = document.createElement('input');
        coordInput.className = 'input rc-input rc-coords';
        coordInput.placeholder = '📍 lat, lon (paste e.g. 51.5074, -0.1278)';
        coordInput.value = formatCoords(coords);
        coordInput.addEventListener('change', () => {
            const txt = coordInput.value.trim();
            if (!txt) { this.onChange('coords', null); return; }
            const c = parseCoords(txt);
            if (c) this.onChange('coords', c);
            else { coordInput.classList.add('is-invalid'); coordInput.title = 'Expected "lat, lon", e.g. 51.5074, -0.1278'; }
        });
        const mapBtn = this._iconBtn('Map', 'Pick the location on a map', () => this._openMap(coords));
        const locBtn = this._iconBtn('⌖', 'Use my current location', () => this._locate(locBtn));
        grid.appendChild(this._row('Location', [coordInput, locBtn, mapBtn], ctx.coords.source, ctx.coords.source === 'manual' ? ['coords'] : []));

        grid.appendChild(this._row('Place', [this._input('locality', 'text', ctx.locality.value ?? '', 'Locality, country')],
            ctx.locality.source, ctx.locality.source === 'manual' ? ['locality'] : []));
        grid.appendChild(this._row('Device', [this._input('device', 'text', ctx.device.value ?? '', 'Recorder / microphone')],
            ctx.device.source, ctx.device.source === 'manual' ? ['device'] : []));

        this.el.appendChild(grid);
        if (coords) this.el.appendChild(buildMiniMap(coords, () => this._openMap(coords)));
    }

    _row(label: string, controls: HTMLElement[], source: string | null, manualFields: ContextField[]) {
        const row = document.createElement('div');
        row.className = 'rc-row';
        const lab = document.createElement('span');
        lab.className = 'rc-label';
        lab.textContent = label;
        row.appendChild(lab);
        const ctl = document.createElement('div');
        ctl.className = 'rc-controls';
        controls.forEach((c) => ctl.appendChild(c));
        row.appendChild(ctl);
        const src = document.createElement('span');
        src.className = 'rc-source';
        if (manualFields.length) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'rc-reset';
            reset.textContent = '↺';
            reset.title = 'Back to the automatic value';
            reset.addEventListener('click', () => manualFields.forEach((f) => this.onChange(f, null)));
            src.append('manual ', reset);
        } else {
            src.textContent = source ? CONTEXT_SOURCE_TEXT[source as keyof typeof CONTEXT_SOURCE_TEXT] : '';
        }
        row.appendChild(src);
        return row;
    }

    _input(field: ContextField, type: string, value: string, placeholder: string) {
        const input = document.createElement('input');
        input.type = type;
        input.className = 'input rc-input';
        input.placeholder = placeholder;
        input.value = value;
        input.addEventListener('change', () => this.onChange(field, input.value.trim() || null));
        return input;
    }

    _iconBtn(text: string, title: string, onClick: () => void) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tb-btn rc-btn';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _openMap(c: Coords | null) {
        openMapModal({
            lat: c?.lat ?? 51, lon: c?.lon ?? 10, zoom: c ? 10 : 5,
            onConfirm: ({ lat, lon }: any) => this.onChange('coords', { lat, lon }),
        });
    }

    _locate(btn: HTMLButtonElement) {
        if (!navigator.geolocation) { btn.title = 'Geolocation not supported by this browser'; return; }
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition(
            (pos) => { btn.disabled = false; this.onChange('coords', { lat: pos.coords.latitude, lon: pos.coords.longitude }); },
            (err) => {
                btn.disabled = false;
                btn.title = err.code === 1 ? 'Permission denied — check browser site settings' : 'Position unavailable — try again';
            },
            { timeout: 8000, maximumAge: 60000 },
        );
    }
}
