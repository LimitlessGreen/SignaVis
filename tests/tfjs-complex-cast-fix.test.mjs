// The WebGL Cast kernel drops the leading dimension of complex64 -> float32 (TF.js bug);
// patchWebglComplexCast reshapes it back. Tested against a fake tf with that behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchWebglComplexCast } from '../src/infrastructure/tfjsComplexCastFix.ts';

function fakeTf() {
    const kernels = new Map();
    const disposed = [];
    const backend = { disposeIntermediateTensorInfo: (t) => disposed.push(t) };
    kernels.set('Cast/webgl', {
        kernelName: 'Cast', backendName: 'webgl',
        // buggy: complex input loses its first dimension
        kernelFunc: ({ inputs: { x } }) => ({ shape: x.dtype === 'complex64' ? x.shape.slice(1) : x.shape, dtype: 'float32' }),
    });
    kernels.set('Reshape/webgl', { kernelFunc: ({ inputs: { x }, attrs }) => ({ shape: attrs.shape, dtype: x.dtype }) });
    const tf = {
        getKernel: (n, b) => kernels.get(`${n}/${b}`),
        unregisterKernel: (n, b) => kernels.delete(`${n}/${b}`),
        registerKernel: (k) => {
            if (kernels.has(`${k.kernelName}/${k.backendName}`)) throw new Error('already registered');
            kernels.set(`${k.kernelName}/${k.backendName}`, k);
        },
    };
    const cast = (x) => tf.getKernel('Cast', 'webgl').kernelFunc({ inputs: { x }, backend, attrs: { dtype: 'float32' } });
    return { tf, cast, disposed };
}

test('without the patch the fake reproduces the bug', () => {
    const { cast } = fakeTf();
    assert.deepEqual(cast({ shape: [1, 511, 1025], dtype: 'complex64' }).shape, [511, 1025]);
});

test('complex64 -> float32 keeps the input shape, the intermediate is disposed', () => {
    const { tf, cast, disposed } = fakeTf();
    assert.equal(patchWebglComplexCast(tf), true);
    const out = cast({ shape: [1, 511, 1025], dtype: 'complex64' });
    assert.deepEqual(out.shape, [1, 511, 1025]);
    assert.deepEqual(disposed.map((t) => t.shape), [[511, 1025]]);
});

test('other casts are untouched, patching twice is a no-op', () => {
    const { tf, cast, disposed } = fakeTf();
    patchWebglComplexCast(tf);
    assert.equal(patchWebglComplexCast(tf), false);
    assert.deepEqual(cast({ shape: [2, 3], dtype: 'int32' }).shape, [2, 3]);
    assert.equal(disposed.length, 0);
});

test('no WebGL backend: nothing to patch', () => {
    const { tf } = fakeTf();
    tf.unregisterKernel('Cast', 'webgl');
    assert.equal(patchWebglComplexCast(tf), false);
});
