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

type BindOn = (
    target: EventTarget | null | undefined,
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: AddEventListenerOptions | boolean,
) => void;

/**
 * Keep UI controller wiring in one place to simplify PlayerState and
 * make future replacement/composition of controller sets easier.
 */
export function bindUiControllers(d: any, state: any, on: BindOn): void {
    new TransportController(d, state).bind(on);
    new FreqViewportController(d, state).bind(on);
    new SettingsPanelController(d, state).bind(on);
    new VolumeController(d, state).bind(on);
    new DisplayGainController(d, state).bind(on);
    new CanvasInteractionController(d, state).bind(on);
    new PlayheadController(d, state).bind(on);
    new DocumentEventsController(state).bind(on);
    new OverviewController(d, state).bind(on);
    new WindowEventsController(state).bind(on);
}
