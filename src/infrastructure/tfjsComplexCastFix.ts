/**
 * Work around a TF.js WebGL bug: casting a complex64 tensor to float32 drops the
 * leading dimension ([1, 511, 1025] comes back as [511, 1025]); the CPU backend
 * keeps it. Graph models that compute their spectrogram in the graph (RFFT, then
 * Cast — e.g. AnuraPAM, converted from a BirdNET-Analyzer SavedModel) then fail
 * with "Size(N) must match the product of shape N,0".
 *
 * Wraps the WebGL Cast kernel and reshapes such a result back to the input shape.
 * Runs inside the TF.js worker (stringified into its source), so it must stay
 * self-contained and use only the `tf` it is given.
 */
export function patchWebglComplexCast(tf: any): boolean {
  const orig = tf.getKernel('Cast', 'webgl');
  if (!orig || orig.complexShapeFix) return false;
  tf.unregisterKernel('Cast', 'webgl');
  tf.registerKernel({
    ...orig,
    complexShapeFix: true,
    kernelFunc(args: any) {
      const out = orig.kernelFunc(args);
      const x = args.inputs.x;
      if (x.dtype !== 'complex64' || out.shape.join() === x.shape.join()) return out;
      const reshaped = tf.getKernel('Reshape', 'webgl').kernelFunc({ inputs: { x: out }, backend: args.backend, attrs: { shape: x.shape } });
      args.backend.disposeIntermediateTensorInfo(out);
      return reshaped;
    },
  });
  return true;
}
