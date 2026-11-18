#!/usr/bin/env bash
# Download AnuraPAM from Zenodo and convert it into models/anurapam/ (TF.js graph model + labels.json).
# Not committed (git-ignored, 78 MB); Zenodo sends no CORS headers, so browsers cannot load it from there.
#
# AnuraPAM: Elsner, Meerheim, Dziock (HTW Dresden), Ernst (Senckenberg),
# https://doi.org/10.5281/zenodo.24119698 — a BirdNET-Analyzer custom classifier
# ("Raw" variant): the 6,522 BirdNET v2.4 classes + 14 Central European anurans.
# Licenses: AnuraPAM release CC BY 4.0; the BirdNET v2.4 base model CC BY-NC-SA 4.0
# (https://github.com/birdnet-team/BirdNET-Analyzer). See the README written below.
#
# Needs: curl, unzip, uv. Tested on Linux x86_64; on Linux ARM64 the TensorFlow
# converter dependencies do not resolve. Usage: npm run models:anurapam
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/models/anurapam"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
py=(uv run -q --no-project --python 3.11)

curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o "$work/raw.zip" "https://zenodo.org/records/24119698/files/AnuraPAM_Raw.zip?download=1"
unzip -q "$work/raw.zip" -d "$work"
src="$work/AnuraPAM_Raw"
stage="$work/anurapam"   # private per run; published only when complete

"${py[@]}" \
  --with "tensorflowjs==4.22.0" --with "tensorflow==2.18.0" --with "tf-keras==2.18.0" \
  --with "ydf==0.9.0" --with "protobuf==5.29.6" --with "setuptools<81" \
  tensorflowjs_converter --input_format=tf_saved_model --output_format=tfjs_graph_model \
  --signature_name=basic "$src/AnuraPAM_Raw" "$stage"

# labels.json: same order as the model output; the taxonomy spells the hybrid without "kl."
"${py[@]}" python -I - "$src/AnuraPAM_Raw_Labels.txt" "$stage/labels.json" <<'EOF'
import json, sys
labels = [l.rstrip('\n') for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
labels = [l.replace('Pelophylax kl. esculentus', 'Pelophylax esculentus') for l in labels]
json.dump(labels, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
EOF

cat > "$stage/README.md" <<'README'
# AnuraPAM (TF.js)

- AnuraPAM: Elsner, B., Meerheim, F., Dziock, F. (HTW Dresden), Ernst, R. (Senckenberg).
  https://doi.org/10.5281/zenodo.24119698 — released under CC BY 4.0.
- It is built on the BirdNET v2.4 model (Kahl et al., K. Lisa Yang Center for Conservation
  Bioacoustics, Cornell Lab of Ornithology / Chemnitz University of Technology,
  https://github.com/birdnet-team/BirdNET-Analyzer), whose models are licensed CC BY-NC-SA 4.0.
  The combined model therefore carries the BirdNET terms: non-commercial use, share alike.
- Changes: converted to a TF.js graph model by scripts/fetch-anurapam.sh; labels.json writes
  "Pelophylax kl. esculentus" as "Pelophylax esculentus".
- Outputs: 6,522 BirdNET v2.4 classes (unchanged) + 14 anurans, sigmoid scores for 3 s of 48 kHz audio.
README

# Swap in the new model; the old one stays until the new one is in place.
if [ -e "$out" ]; then mv "$out" "$work/previous"; fi
if ! mv "$stage" "$out"; then
  [ -e "$work/previous" ] && mv "$work/previous" "$out"
  echo "could not install models/anurapam" >&2; exit 1
fi
echo "models/anurapam ready"
