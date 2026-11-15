# Integration Examples

## ESM (Vite / Vanilla)

```js
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

## Load from URL

```js
await player.loadUrl('/audio/birdsong.mp3')
player.play()
```

## File Input

```js
const input = document.querySelector('#audio')
input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return
  await player.loadFile(file)
})
```

## Record from the microphone

While recording, the spectrogram pane shows the sound as it arrives (it flies
in from the right, 20 s across). When it stops — Stop button, `stopRecording()`
or after `maxSeconds` — the recording is loaded like a file. The WAV carries
its start time, so `player.recordingStart` knows the clock time (the labeling app's
Raven selection tables use it; `player.exportAnnotationsRaven()` has no clock columns).

```js
if (BirdNETPlayer.recordingSupported) {
  player.on('recordingcomplete', ({ detail }) => {
    console.log(detail.file.name, detail.duration) // Recording_20261115_143012.wav
  })
  await player.startRecording({ maxSeconds: 300 }) // asks for microphone access
  // … later
  await player.stopRecording()
}
```

Pass `loadWhenDone: false` to handle `detail.file` yourself.

## Recording start time

`player.recordingStart` is read from AudioMoth, GUANO, BWF `bext` or WAV INFO
metadata, or from a date and time in the file name (`20230512_190000.wav`);
`null` when unknown. `player.clockTimeAt(seconds)` gives the wall-clock time at
a position, e.g. `"2023-05-12T19:00:03.000+01:00"`.

## React

```jsx
import { useEffect, useRef } from 'react'
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

export default function Player() {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    const p = new BirdNETPlayer(ref.current)
    return () => p.destroy()
  }, [])
  return <div ref={ref} />
}
```

## Vue

```js
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

const root = ref(null)
let player

onMounted(() => { player = new BirdNETPlayer(root.value) })
onBeforeUnmount(() => player?.destroy())
```

## Svelte

```svelte
<script>
  import { onMount } from 'svelte'
  import { BirdNETPlayer } from 'signavis'
  import 'signavis/style'

  let el
  let player
  onMount(() => {
    player = new BirdNETPlayer(el)
    return () => player.destroy()
  })
</script>

<div bind:this={el}></div>
```

## CDN / IIFE

```html
<script src="https://unpkg.com/wavesurfer.js@7"></script>
<script src="https://unpkg.com/signavis/dist/birdnet-player.iife.js"></script>
<link rel="stylesheet" href="https://unpkg.com/signavis/dist/birdnet-player.css" />
<div id="player"></div>
<script>
  const player = new BirdNETPlayerModule.BirdNETPlayer(document.getElementById('player'))
</script>
```

## Streamlit (Python)

```python
from signavis import render_daw_player
import streamlit.components.v1 as components

components.html(render_daw_player(audio_bytes), height=620, scrolling=False)
```

## Jupyter Notebook

```python
from IPython.display import HTML
from signavis import render_daw_player

HTML(render_daw_player(audio_bytes))
```

See [python-wrapper/README.md](https://github.com/LimitlessGreen/SignaVis/blob/main/python-wrapper/README.md)
for the full Python API, presets and advanced spectrogram injection.
