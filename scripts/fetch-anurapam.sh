#!/usr/bin/env bash
# Download AnuraPAM from Zenodo and write its anuran classifier head into models/anurapam/
# (model.json + head.bin, 4 MB, + labels.json). The app runs it on the embeddings of the
# bundled BirdNET v2.4 model (models/birdnet-v2.4), which AnuraPAM is built on; the full
# export contains that backbone twice. Zenodo sends no CORS headers, so browsers cannot load it from there.
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
graph="$work/graph"      # full converted graph, only read for the head weights
stage="$work/anurapam"   # private per run; published only when complete
mkdir -p "$stage"

"${py[@]}" \
  --with "tensorflowjs==4.22.0" --with "tensorflow==2.18.0" --with "tf-keras==2.18.0" \
  --with "ydf==0.9.0" --with "protobuf==5.29.6" --with "setuptools<81" \
  tensorflowjs_converter --input_format=tf_saved_model --output_format=tfjs_graph_model \
  --signature_name=basic "$src/AnuraPAM_Raw" "$graph"
node "$root/scripts/anurapam-head.mjs" "$graph" "$stage"

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
- Changes: only the classifier head (two dense layers on the v2.4 embeddings) is kept, extracted by
  scripts/fetch-anurapam.sh and scripts/anurapam-head.mjs; SignaVis runs it on models/birdnet-v2.4. labels.json writes
  "Pelophylax kl. esculentus" as "Pelophylax esculentus".
- Outputs: 6,522 BirdNET v2.4 classes (unchanged) + 14 anurans, sigmoid scores for 3 s of 48 kHz audio.
README

# Publish under a lock so concurrent runs cannot interleave. The previous model is kept
# next to models/anurapam (outside the auto-cleaned work dir) until the swap has succeeded,
# so an interruption never leaves the preset without a model.
mkdir -p "$root/models"
exec 9>"$root/models/.anurapam.lock"
flock 9
backup="$out.previous"
rm -rf "$backup"
if [ -e "$out" ]; then mv "$out" "$backup"; fi
if ! mv -T "$stage" "$out"; then
  if [ -e "$backup" ] && [ ! -e "$out" ]; then mv -T "$backup" "$out"; fi
  echo "could not install models/anurapam (previous model kept at $backup if restore failed)" >&2; exit 1
fi
rm -rf "$backup"
echo "models/anurapam ready"
