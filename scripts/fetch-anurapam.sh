#!/usr/bin/env bash
# Download AnuraPAM from Zenodo and convert it into models/anurapam/ (TF.js graph model + labels.json).
# Not committed (git-ignored, 78 MB); Zenodo sends no CORS headers, so browsers cannot load it from there.
#
# AnuraPAM: Elsner, Meerheim, Dziock (HTW Dresden), Ernst (Senckenberg), CC BY 4.0,
# https://doi.org/10.5281/zenodo.24119698 — a BirdNET-Analyzer custom classifier
# (BirdNET v2.4, 6,522 birds + 14 Central European anurans, "Raw" variant).
#
# Needs: curl, unzip, uv (Python 3.11). Usage: npm run models:anurapam
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/models/anurapam"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o "$work/raw.zip" "https://zenodo.org/records/24119698/files/AnuraPAM_Raw.zip?download=1"
unzip -q "$work/raw.zip" -d "$work"
src="$work/AnuraPAM_Raw"

rm -rf "$out.tmp" && mkdir -p "$out.tmp"
uv run -q --no-project --python 3.11 \
  --with "tensorflowjs==4.22.0" --with "tensorflow==2.18.0" --with "tf-keras==2.18.0" \
  --with "ydf==0.9.0" --with "protobuf==5.29.6" --with "setuptools<81" \
  tensorflowjs_converter --input_format=tf_saved_model --output_format=tfjs_graph_model \
  --signature_name=basic "$src/AnuraPAM_Raw" "$out.tmp"

# labels.json: same order as the model output; the taxonomy spells the hybrid without "kl."
python3 -I - "$src/AnuraPAM_Raw_Labels.txt" "$out.tmp/labels.json" <<'EOF'
import json, sys
labels = [l.rstrip('\n') for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
labels = [l.replace('Pelophylax kl. esculentus', 'Pelophylax esculentus') for l in labels]
json.dump(labels, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
EOF

cat > "$out.tmp/README.md" <<'README'
AnuraPAM: Elsner, Meerheim, Dziock (HTW Dresden), Ernst (Senckenberg). CC BY 4.0,
https://doi.org/10.5281/zenodo.24119698. Converted to TF.js by scripts/fetch-anurapam.sh;
labels.json writes "Pelophylax kl. esculentus" as "Pelophylax esculentus".
README
rm -rf "$out" && mv "$out.tmp" "$out"
echo "models/anurapam ready"
