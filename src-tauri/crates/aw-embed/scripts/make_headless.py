"""Perch-2-ONNX auf die Ausgabe `embedding` zuschneiden (ohne Klassifikationskopf).

python make_headless.py <perch_v2.onnx> <perch_v2_embed.onnx>
"""
import sys
import onnx

m = onnx.load(sys.argv[1])
g = m.graph
producer = {o: n for n in g.node for o in n.output}
need, stack, keep = set(), ["embedding"], set()
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
del g.output[:]; g.output.extend(outs)
vi = [v for v in g.value_info if v.name in need]
del g.value_info[:]; g.value_info.extend(vi)
onnx.save(m, sys.argv[2])
print("Knoten:", len(producer), "->", len(nodes), "| Initializer:", len(inits))
