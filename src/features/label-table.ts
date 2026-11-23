// ═══════════════════════════════════════════════════════════════════════
// features/label-table.ts — package entry 'signavis/label-table'
//
// The sortable label table under the player, as a player feature:
//   new BirdNETPlayer(el, { features: [labelTable({ columns: ['label', 'start'] })] });
// With the full 'signavis' entry, { labelTable: true, labelTableColumns } does the same.
// ═══════════════════════════════════════════════════════════════════════

import { LabelGrid } from '../ui/panels/label-grid.ts';
import type { PlayerFeature } from '../app/playerFeature.ts';
import type { BirdNETPlayer } from '../app/BirdNETPlayer.ts';

export interface LabelTableOptions {
    /** Columns the table starts with (keys as in its column menu). */
    columns?: string[];
    /** Key for sort, filter and column preferences (default: shared by all embeds). */
    storageKey?: string;
}

export function labelTable(options: LabelTableOptions = {}): PlayerFeature {
    return {
        name: 'labelTable',
        install(player: BirdNETPlayer) {
            const host = player.enableLabelTable();
            if (!host) return;
            const grid = new LabelGrid({
                host,
                tools: player.getLabelTableTools(),
                resolveName: (l: any) => ({
                    display: l.commonName || l.label || l.species || '',
                    scientific: l.scientificName && l.scientificName !== (l.commonName || l.label) ? l.scientificName : '',
                }),
                isLocked: (l: any) => player.readOnly || !!l.readonly,
                getViewRange: () => player.getVisibleTimeRange(),
                getDuration: () => player.duration,
                getMaxFreq: () => player.sampleRate / 2,
                onChange: () => {},
                onFocus: (id: string) => {
                    const l = player.getLabel(id);
                    player.emit('labelfocus', { id, source: 'table', interaction: 'click' });
                    if (l) player.seekTo(l.start);
                },
                onHover: (id: string | null) => player.emit('labelfocus', { id, source: 'table', interaction: 'hover' }),
                onTogglePlay: () => player.togglePlayPause(),
                columns: Array.isArray(options.columns) ? options.columns : undefined,
                storageKey: options.storageKey ?? 'signavis.labelgrid.embed.v1',
            });
            const refresh = () => grid.render(player.getLabels());
            const offs = [
                player.on('labelsync', refresh),
                player.on('timeupdate', (e: any) => grid.setPlayhead(e.detail?.currentTime ?? player.currentTime)),
                player.on('labelfocus', (e: any) => {
                    const d = e.detail || {};
                    if (d.source === 'table') return;
                    if (d.interaction === 'click') grid.highlightRow(d.id ?? null);
                    else grid.setHover(d.id ?? null);
                }),
            ];
            refresh();
            player.setLabelView('table');
            return () => {
                for (const off of offs) if (typeof off === 'function') off();
                grid.destroy();
            };
        },
    };
}
