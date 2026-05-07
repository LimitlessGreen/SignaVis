import { TransportController } from '../ui/components/transport/transport-controller.ts';
import { SettingsPanelController } from '../ui/components/settings-panel/settings-panel-controller.ts';
import { VolumeController } from '../ui/components/volume/volume-controller.ts';
import { DisplayGainController } from '../ui/components/display-gain/display-gain-controller.ts';
import { PlayheadController } from '../ui/components/playhead/playhead-controller.ts';
import { FreqViewportController } from '../ui/components/freq-viewport/freq-viewport-controller.ts';
import { CanvasInteractionController } from '../ui/components/canvas-interaction/canvas-interaction-controller.ts';
import { OverviewController } from '../ui/components/overview/overview-controller.ts';
import { DocumentEventsController } from '../ui/components/document-events/document-events-controller.ts';
import { WindowEventsController } from '../ui/components/window-events/window-events-controller.ts';
import type { UiController, OnFn } from '../ui/components/shared/controller.types.ts';

/**
 * Keep UI controller wiring in one place to simplify PlayerState and
 * make future replacement/composition of controller sets easier.
 */
export function bindUiControllers(d: any, state: any, on: OnFn): void {
    const controllers: UiController[] = [
        new TransportController(d, state),
        new FreqViewportController(d, state),
        new SettingsPanelController(d, state),
        new VolumeController(d, state),
        new DisplayGainController(d, state),
        new CanvasInteractionController(d, state),
        new PlayheadController(d, state),
        new DocumentEventsController(state),
        new OverviewController(d, state),
        new WindowEventsController(state),
    ];
    for (const c of controllers) c.bind(on);
}
