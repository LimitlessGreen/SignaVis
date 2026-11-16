// ONNX protobuf helpers to split a BirdBox model into its streaming graphs.
import { Buffer } from "node:buffer";
//
// Adapted from scripts/fetch-models.mjs in the BirdNET website
// (https://github.com/birdnet-team/birdnet-website, MIT License,
// Copyright (c) 2025-2026 BirdNET-Team); the same as floorCut/streamGraphs in
// BirdBox's docs/javascripts/demo/onnx-graph.js.
function readVarint(buf, pos) {
  let result = 0n, shift = 0n;
  for (;;) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}

function encodeVarint(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** Iterate the top-level fields of a protobuf message. */
function* fields(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos < end) {
    const tagStart = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    let valueStart = pos, valueEnd, varint;
    if (wire === 0) { [varint, pos] = readVarint(buf, pos); valueEnd = pos; }
    else if (wire === 1) { pos += 8; valueEnd = pos; }
    else if (wire === 5) { pos += 4; valueEnd = pos; }
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      valueStart = pos;
      pos += Number(len);
      valueEnd = pos;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
    yield { field, wire, tagStart, valueStart, valueEnd, end: pos, varint };
  }
}

const str = (buf, f) => buf.toString('utf8', f.valueStart, f.valueEnd);
const lenField = (field, payload) => Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
const varintField = (field, value) => Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);

function parseNode(buf, f) {
  const node = { inputs: [], outputs: [], op: '' };
  for (const g of fields(buf, f.valueStart, f.valueEnd)) {
    if (g.field === 1) node.inputs.push(str(buf, g));
    else if (g.field === 2) node.outputs.push(str(buf, g));
    else if (g.field === 4) node.op = str(buf, g);
  }
  return node;
}

function parseTensor(buf, f) {
  const t = { dims: [], dataType: 0, name: '', raw: null };
  for (const g of fields(buf, f.valueStart, f.valueEnd)) {
    if (g.field === 1) {
      if (g.wire === 0) t.dims.push(Number(g.varint));
      else for (let p = g.valueStart; p < g.valueEnd;) { const [v, n] = readVarint(buf, p); t.dims.push(Number(v)); p = n; }
    } else if (g.field === 2) t.dataType = Number(g.varint);
    else if (g.field === 8) t.name = str(buf, g);
    else if (g.field === 9) t.raw = buf.subarray(g.valueStart, g.valueEnd);
  }
  return t;
}

function parseGraph(buf) {
  const nodes = [], inits = new Map();
  for (const f of fields(buf)) {
    if (f.field === 1) nodes.push({ ...parseNode(buf, f), record: buf.subarray(f.tagStart, f.end) });
    else if (f.field === 5) inits.set(parseTensor(buf, f).name, buf.subarray(f.tagStart, f.end));
  }
  return { nodes, inits, producers: new Map(nodes.flatMap(n => n.outputs.map(o => [o, n]))) };
}

/** The nodes `roots` depend on, and the tensors they read that no node produces (or that are in `stop`). */
function ancestors(graph, roots, stop = new Set()) {
  const nodes = new Set(), leaves = new Set(), seen = new Set(), todo = [...roots];
  while (todo.length) {
    const name = todo.pop();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const node = stop.has(name) ? null : graph.producers.get(name);
    if (!node) { leaves.add(name); continue; }
    nodes.add(node);
    todo.push(...node.inputs);
  }
  return { nodes, leaves };
}

/** The model's metadata_props as an object. */
function modelMetadata(model) {
  const out = {};
  for (const f of fields(model)) {
    if (f.field !== 14) continue;
    let key = null, value = '';
    for (const g of fields(model, f.valueStart, f.valueEnd)) {
      if (g.field === 1) key = str(model, g);
      else if (g.field === 2) value = str(model, g);
    }
    if (key != null) out[key] = value;
  }
  return out;
}

/**
 * stream_detect with each window's noise floor as an input, so the page computes it
 * (RollingFloor in birdbox-stream.js) and the network needs only the windows' own
 * frames. The same as floorCut in BirdBox's docs/javascripts/demo/onnx-graph.js: the
 * floor, (n_mels, windows, 1), is the interpolated percentile the graph takes from the
 * sorted frames of the floor window (TopK), and enters the image as the input of the
 * first Transpose after the TopK. The nodes only the floor needs go, and with them the
 * inputs only they read (sound). An Identity node gives the input its name, `floor`.
 *
 * @returns the function, cut; null if it has no single TopK leading to a Transpose
 */
function floorCut(fn) {
  const consumers = new Map();
  for (const n of fn.nodes) for (const t of n.inputs) (consumers.get(t) || consumers.set(t, []).get(t)).push(n);
  const topk = fn.nodes.filter(n => n.op === 'TopK');
  if (topk.length !== 1) return null;
  let cut = null;
  const seen = new Set(), queue = [topk[0]];
  while (queue.length && !cut) {
    for (const t of queue.shift().outputs) {
      for (const n of consumers.get(t) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (n.op === 'Transpose') { cut = n.inputs[0]; break; }
        queue.push(n);
      }
      if (cut) break;
    }
  }
  if (!cut) return null;
  const graph = { producers: new Map(fn.nodes.flatMap(n => n.outputs.map(o => [o, n]))) };
  const { nodes, leaves } = ancestors(graph, fn.outputs, new Set([cut]));
  if ([...nodes].some(n => n.op === 'TopK')) return null;   // the floor is still computed somewhere else
  const identity = Buffer.concat([lenField(1, Buffer.from('floor')), lenField(2, Buffer.from(cut)), lenField(4, Buffer.from('Identity'))]);
  return {
    ...fn,
    nodes: [{ op: 'Identity', inputs: ['floor'], outputs: [cut], record: lenField(1, identity) }, ...fn.nodes.filter(n => nodes.has(n))],
    inputs: [...fn.inputs.filter(t => leaves.has(t)), 'floor'],
  };
}

/**
 * The streaming graphs of a BirdBox model with a rolling noise floor, as two
 * models the demo runs in turn (birdbox-stream.js):
 *
 *   spectrogram(audio) -> db (n_mels, frames), sound (frames)
 *   detect(db, first_frame, times, conf, floor) -> raw, the boxes of the windows
 *       starting at `times`, before window fusion, with their floors from the page
 *       (floorCut)
 *
 * BirdBox's export stores them in the model as ONNX functions (domain
 * birdbox.stream). Their other inputs are tensors of the model: weights of its
 * segment Loop body, and the DFT kernel its graph builds. Those become
 * initializers and leading nodes here. A window's rows equal those of the whole
 * graph, so the demo can show boxes a few seconds of audio at a time, and while
 * a recording is still in progress.
 */
function streamGraphs(model) {
  const functions = new Map();
  for (const f of fields(model)) {
    if (f.field !== 25) continue;   // FunctionProto: name 1, input 4, output 5, node 7, domain 10
    const fn = { name: '', domain: '', inputs: [], outputs: [], nodes: [] };
    for (const g of fields(model, f.valueStart, f.valueEnd)) {
      if (g.field === 1) fn.name = str(model, g);
      else if (g.field === 10) fn.domain = str(model, g);
      else if (g.field === 4) fn.inputs.push(str(model, g));
      else if (g.field === 5) fn.outputs.push(str(model, g));
      else if (g.field === 7) fn.nodes.push({ ...parseNode(model, g), record: lenField(1, model.subarray(g.valueStart, g.valueEnd)) });
    }
    if (fn.domain === 'birdbox.stream') functions.set(fn.name, fn);
  }
  const spectrogram = functions.get('stream_spectrogram'), detect = functions.get('stream_detect');
  if (!spectrogram || !detect) throw new Error('BirdBox: the model has no streaming graphs');

  const graphField = [...fields(model)].find(f => f.field === 7);
  if (!graphField) throw new Error('No graph in ModelProto');
  const graphBytes = model.subarray(graphField.valueStart, graphField.valueEnd), top = parseGraph(graphBytes);
  const loopField = [...fields(graphBytes)].find(f => f.field === 1 && parseNode(graphBytes, f).op === 'Loop');
  if (!loopField) throw new Error('BirdBox: no segment Loop');
  let body = null;
  for (const a of fields(graphBytes, loopField.valueStart, loopField.valueEnd)) {
    if (a.field !== 5) continue;   // AttributeProto, field 6 = graph
    const g = [...fields(graphBytes, a.valueStart, a.valueEnd)].find(x => x.field === 6);
    if (g) body = parseGraph(graphBytes.subarray(g.valueStart, g.valueEnd));
  }
  if (!body) throw new Error('BirdBox: the segment Loop has no body');

  // ValueInfoProto { name, type { tensor_type { elem_type, shape } } }; without dims the shape stays open
  const ELEM = { float32: 1, int64: 7, bool: 9 };
  const valueInfo = (name, type, dims) => {
    if (!type) return lenField(1, Buffer.from(name));
    const shape = dims ? [lenField(2, Buffer.concat(dims.map(d => lenField(1, varintField(1, d)))))] : [];
    return Buffer.concat([lenField(1, Buffer.from(name)), lenField(2, lenField(1, Buffer.concat([varintField(1, ELEM[type]), ...shape])))]);
  };
  const build = (fn, types) => {
    const weights = fn.inputs.filter(name => body.inits.has(name));
    const outer = fn.inputs.filter(name => !body.inits.has(name) && (top.producers.has(name) || top.inits.has(name)));
    const prelude = ancestors(top, outer);
    const inputs = fn.inputs.filter(name => !weights.includes(name) && !outer.includes(name));
    const unknown = inputs.filter(name => !types[name]);
    if (unknown.length) throw new Error(`BirdBox: ${fn.name} reads ${unknown.join(', ')}, which the model does not have`);
    const graph = Buffer.concat([
      ...top.nodes.filter(n => prelude.nodes.has(n)).map(n => n.record),
      ...fn.nodes.map(n => n.record),
      lenField(2, Buffer.from(fn.name)),
      ...weights.map(name => body.inits.get(name)),
      ...[...prelude.leaves].filter(name => top.inits.has(name)).map(name => top.inits.get(name)),
      ...inputs.map(name => lenField(11, valueInfo(name, ...types[name]))),
      ...fn.outputs.map(name => lenField(12, valueInfo(name))),
    ]);
    return Buffer.concat([model.subarray(0, graphField.tagStart), lenField(7, graph), model.subarray(graphField.end)]);
  };
  const floored = floorCut(detect);
  if (!floored) throw new Error('BirdBox: stream_detect could not be cut at the noise floor (floorCut)');
  return {
    spectrogram: build(spectrogram, { audio: ['float32'] }),
    detect: build(floored, { db: ['float32'], first_frame: ['int64', []], times: ['float32'], conf: ['float32'], floor: ['float32'] }),
  };
}

export { modelMetadata, streamGraphs };
