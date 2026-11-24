// The frequency axis and the crosshair layer follow the canvas height in the same frame;
// a frame later the player briefly grew by the crosshair layer's height on load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramController } from '../src/app/SpectrogramController.ts';

test('the axis and crosshair follow a new canvas height at once', () => {
    let rafs = 0;
    globalThis.requestAnimationFrame = () => { rafs++; return 1; };
    const d = {
        spectrogramCanvas: { height: 450 },
        freqAxisSpacer: { style: {} },
        crosshairCanvas: { style: {} },
    };
    SpectrogramController.prototype._syncFreqAxisHeight.call({ _d: d });
    assert.equal(d.freqAxisSpacer.style.height, '450px');
    assert.equal(d.crosshairCanvas.style.marginTop, '-450px');
    assert.equal(rafs, 0);
});
