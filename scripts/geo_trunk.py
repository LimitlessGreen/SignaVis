"""Split a BirdNET+ geomodel ONNX into a trunk and its species output layer.

The range map needs one species at thousands of grid points. The full model computes all
~10k species per point and returns them (10k floats per point to copy back); the trunk stops
at the last hidden layer (96 values), and the app applies the output layer of one species
itself. The trunk keeps FP16 weights (half the download) but computes in FP32: the WebGPU
backend of onnxruntime-web returns wrong scores for the FP16 graph.

Writes into <out>/: trunk.onnx, head.bin (fp16 weights [n x d] row-major, then fp32 bias [n]),
head.json ({n, d, hidden, rows}: rows[k][i] = output row k of geo label i; score = max over k
of sigmoid(W[row] . h + b[row])).

Usage: python geo_trunk.py <geomodel.onnx> <out dir>
"""
import json
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper, utils

src, out = sys.argv[1], sys.argv[2]
model = onnx.load(src)
g = model.graph
by_out = {o: n for n in g.node for o in n.output}
init = {t.name: t for t in g.initializer}

# Output layer: the Gemm that feeds the Sigmoid.
sig = next(n for n in g.node if n.op_type == 'Sigmoid')
gemm = by_out[sig.input[0]]
assert gemm.op_type == 'Gemm', gemm.op_type
hidden, w_name, b_name = gemm.input[0], gemm.input[1], gemm.input[2]
trans_b = next((a.i for a in gemm.attribute if a.name == 'transB'), 0)
W = numpy_helper.to_array(init[w_name]).astype(np.float32)
if not trans_b:
    W = W.T
b = numpy_helper.to_array(init[b_name]).astype(np.float32)
n, d = W.shape

# Label -> output rows: Gather(species_rows_k) + Max in the BNL export, identity otherwise.
after = {sig.output[0]}
for node in g.node:  # the Sigmoid output and Casts of it
    if node.op_type == 'Cast' and node.input[0] in after:
        after.add(node.output[0])
gathers = [x for x in g.node if x.op_type == 'Gather' and x.input[0] in after and x.input[1] in init]
rows = [numpy_helper.to_array(init[x.input[1]]).astype(np.int64).tolist() for x in gathers] or [list(range(n))]

# Trunk: graph input -> hidden, FP16 weights cast to FP32 at run time, FP32 casts.
utils.extract_model(src, out + '/trunk.raw.onnx', [g.input[0].name], [hidden])
t = onnx.load(out + '/trunk.raw.onnx')
tg = t.graph
f16 = [x.name for x in tg.initializer if x.data_type == TensorProto.FLOAT16]
casts = [helper.make_node('Cast', [nm], [nm + '__f32'], to=TensorProto.FLOAT, name='f32_' + nm) for nm in f16]
fs = set(f16)
for node in tg.node:
    for k, x in enumerate(node.input):
        if x in fs:
            node.input[k] = x + '__f32'
    if node.op_type == 'Cast':
        for a in node.attribute:
            if a.name == 'to' and a.i == TensorProto.FLOAT16:
                a.i = TensorProto.FLOAT
    if node.op_type == 'Constant':
        for a in node.attribute:
            if a.HasField('t') and a.t.data_type == TensorProto.FLOAT16:
                a.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(a.t).astype(np.float32), a.t.name))
nodes = casts + list(tg.node)
del tg.node[:]
tg.node.extend(nodes)
for vi in list(tg.value_info) + list(tg.output):
    if vi.type.tensor_type.elem_type == TensorProto.FLOAT16:
        vi.type.tensor_type.elem_type = TensorProto.FLOAT
onnx.checker.check_model(t)
onnx.save(t, out + '/trunk.onnx')
import os
os.remove(out + '/trunk.raw.onnx')

with open(out + '/head.bin', 'wb') as f:
    f.write(W.astype('<f2').tobytes())
    f.write(b.astype('<f4').tobytes())
json.dump({'n': int(n), 'd': int(d), 'hidden': hidden, 'input': g.input[0].name, 'rows': rows},
          open(out + '/head.json', 'w'), separators=(',', ':'))

# Check: trunk + head against the full model on a few points.
import onnxruntime as ort
pts = np.array([[51.34, 12.37, 20], [-3.5, -62.0, 4], [23.0, 10.0, 30], [64.0, -20.0, 44]], np.float32)
full = ort.InferenceSession(src).run(None, {g.input[0].name: pts})[0]
h = ort.InferenceSession(out + '/trunk.onnx').run(None, {g.input[0].name: pts})[0]
Wq = W.astype(np.float16).astype(np.float32)
p = 1 / (1 + np.exp(-(h @ Wq.T + b)))
mine = np.max(np.stack([p[:, r] for r in rows]), axis=0)
err = float(np.abs(mine - full).max())
print(f'trunk {n}x{d}, {len(rows)} row sets, labels {len(rows[0])}, max |diff| vs full model {err:.5f}')
assert err < 0.01, err
