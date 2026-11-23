"""Perch-2-ONNX auf `embedding` + `score_logit` zuschneiden, Kopf int8.

`score_logit` = max. Klassen-Logit pro Fenster (ReduceMax ueber `label`).
Nur die MatMul des ProtoPNet-Kopfs (1536 x 59180) wird dynamisch auf int8
quantisiert; der Rumpf bleibt f32, `embedding` ist damit bitgleich zum
headless-Modell (make_headless.py).

uv run --with onnx --with onnxruntime python make_scored.py <perch_v2_no_dft.onnx> <out.onnx>
"""
import os
import sys
import tempfile

import onnx
from onnx import TensorProto, helper
from onnxruntime.quantization import QuantType, quantize_dynamic

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
assert m.opset_import[0].version >= 18, "ReduceMax mit Achsen-Eingabe braucht Opset >= 18"
g.node.append(helper.make_node("ReduceMax", ["label", "score_axes"], ["score_logit"], keepdims=0))
g.initializer.append(helper.make_tensor("score_axes", TensorProto.INT64, [1], [1]))

producer = {o: n for n in g.node for o in n.output}
need, stack, keep = set(), ["embedding", "score_logit"], set()
while stack:
    t = stack.pop()
    if t in need:
        continue
    need.add(t)
    n = producer.get(t)
    if n is not None and id(n) not in keep:
        keep.add(id(n))
        stack.extend(i for i in n.input if i)
nodes = [n for n in g.node if id(n) in keep]
inits = [t for t in g.initializer if t.name in need]
del g.node[:]; g.node.extend(nodes)
del g.initializer[:]; g.initializer.extend(inits)
outs = [o for o in g.output if o.name == "embedding"]
outs.append(helper.make_tensor_value_info("score_logit", TensorProto.FLOAT, ["batch"]))
del g.output[:]; g.output.extend(outs)
vi = [v for v in g.value_info if v.name in need]
del g.value_info[:]; g.value_info.extend(vi)

dims = {t.name: list(t.dims) for t in g.initializer}
head = [n.name for n in g.node if n.op_type == "MatMul" and any(dims.get(i) == [1536, 59180] for i in n.input)]
assert len(head) == 1, head

with tempfile.TemporaryDirectory() as d:
    tmp = os.path.join(d, "scored_f32.onnx")
    onnx.save(m, tmp)
    quantize_dynamic(tmp, dst, weight_type=QuantType.QInt8, nodes_to_quantize=head)
print("Knoten:", len(nodes), "| Kopf int8:", head[0])
