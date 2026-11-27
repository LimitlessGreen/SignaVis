#!/usr/bin/env bash
# Split the BirdNET+ geomodel of models/birdnet-v3.0 into trunk + output layer for the range map
# (models/geo-trunk-v3.0: trunk.onnx, head.bin, head.json, ~7 MB). See scripts/geo_trunk.py.
# Same licence as the geomodel (Apache-2.0, birdnet-team). Needs: uv. Usage: npm run models:fetch -- geo-trunk-v3.0
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/models/birdnet-v3.0/BirdNET+_Geomodel_V3.0.4_Global_10K_FP16_BNL.onnx"
out="$root/models/geo-trunk-v3.0"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
uv run -q --no-project --python 3.11 --with "onnx==1.19.1" --with "onnxruntime==1.23.2" --with "numpy<3" \
  python -I "$root/scripts/geo_trunk.py" "$src" "$stage"
cat > "$stage/README.md" <<'MD'
Trunk and output layer of BirdNET+_Geomodel_V3.0.4_Global_10K_FP16_BNL.onnx (models/birdnet-v3.0),
split by scripts/geo_trunk.py for the SignaVis range map. Model: BirdNET Geomodel, birdnet-team,
Apache-2.0 (see ../birdnet-v3.0/MODEL_LICENSE). Changes: graph cut before the output layer,
FP16 weights computed in FP32; output layer stored separately (head.bin).
MD
cp "$root/models/birdnet-v3.0/MODEL_LICENSE" "$stage/MODEL_LICENSE"
rm -rf "$out.part"; cp -r "$stage" "$out.part"; rm -rf "$out"; mv "$out.part" "$out"
echo "✓ geo-trunk-v3.0"
