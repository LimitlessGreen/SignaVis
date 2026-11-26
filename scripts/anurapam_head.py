"""Write the AnuraPAM classifier head (head.bin) from its SavedModel, without the TF.js converter.

AnuraPAM ("Raw" export) computes sigmoid(concat(v2.4 logits, dense_2(relu(dense_1(embeddings))))).
The head weights are constants of the frozen signature; their names are anonymous, so the
kernels are found by shape and the first bias by checking against the model itself: the head
must reproduce the model's anuran scores on random input, or nothing is written.

Usage: python anurapam_head.py <saved model dir> <head.bin>
"""
import sys

import numpy as np
import tensorflow as tf
from tensorflow.python.framework.convert_to_constants import convert_variables_to_constants_v2

src, out = sys.argv[1], sys.argv[2]
m = tf.saved_model.load(src)
g = convert_variables_to_constants_v2(m.signatures['basic']).graph.as_graph_def()
consts = {}
for n in list(g.node) + [n for f in g.library.function for n in f.node_def]:
    if n.op == 'Const':
        consts.setdefault(n.name, tf.make_ndarray(n.attr['value'].tensor))


def only(shape):
    found = [a for a in consts.values() if a.shape == shape and a.dtype == np.float32]
    if len(found) != 1:
        sys.exit(f'expected one {shape} constant, found {len(found)}')
    return found[0]


k1, k2, b2 = only((1024, 1024)), only((1024, 14)), only((14,))
x = tf.random.stateless_normal([4, 144000], seed=[7, 7], stddev=0.1)
emb = m.pb_model.signatures['embeddings'](inputs=x)['embeddings'].numpy()
want = m.signatures['basic'](inputs=x)['scores'].numpy()[:, -14:]


def head(b1):
    h = np.maximum(emb @ k1 + b1, 0) @ k2 + b2
    return 1 / (1 + np.exp(-h))


errs = sorted((float(np.abs(head(b) - want).max()), name) for name, b in consts.items()
              if b.shape == (1024,) and b.dtype == np.float32)
best, name = errs[0]
if best > 1e-4 or (len(errs) > 1 and errs[1][0] < 1e-2):
    sys.exit(f'no unique dense_1 bias reproduces the model: {errs[:3]}')
b1 = consts[name]
np.concatenate([a.astype('<f4').ravel() for a in (k1, b1, k2, b2)]).tofile(out)
print(f'head.bin: 1024x1024 relu -> 1024x14, max |head - model| = {best:.2e}')
