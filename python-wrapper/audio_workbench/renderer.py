import base64
import html
import json
from importlib.resources import files


_PLAYER_JS = (
    files("audio_workbench.assets")
    .joinpath("birdnet-player.iife.js")
    .read_text(encoding="utf-8")
    .replace("</script>", "<\\/script>")
)
_PLAYER_CSS = (
    files("audio_workbench.assets")
    .joinpath("birdnet-player.css")
    .read_text(encoding="utf-8")
)


def render_daw_player(audio_bytes: bytes, **options) -> str:
    """Return an embeddable HTML iframe string with BirdNET DAW player.

    Parameters
    ----------
    audio_bytes : bytes
        Raw audio bytes (e.g. WAV/MP3).
    options : dict
        Passed to BirdNETPlayer constructor.
    """
    iframe_height = int(options.pop("iframe_height", 620) or 620)
    iframe_height = max(180, min(1600, iframe_height))
    b64 = base64.b64encode(audio_bytes).decode("ascii")
    opts = json.dumps(options or {})

    srcdoc = f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset='utf-8' />
  <meta name='viewport' content='width=device-width, initial-scale=1' />
  <script src='https://unpkg.com/wavesurfer@7'></script>
  <style>{_PLAYER_CSS}</style>
  <style>
    html, body {{ margin:0; padding:0; width:100%; height:100%; overflow:hidden; }}
    #player {{ width:100%; height:100%; }}
  </style>
</head>
<body>
  <div id='player'></div>
  <script>{_PLAYER_JS}</script>
  <script>
    (async function() {{
      if (!window.BirdNETPlayerModule?.BirdNETPlayer) {{
        document.body.innerHTML = "<pre style='padding:12px;color:#b91c1c'>BirdNETPlayerModule failed to load</pre>";
        return;
      }}
      const playerRoot = document.getElementById('player');
      const player = new BirdNETPlayerModule.BirdNETPlayer(playerRoot, {opts});
      await player.ready;
      const binary = atob('{b64}');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'audio.wav', {{ type: 'audio/wav' }});
      await player.loadFile(file);
    }})();
  </script>
</body>
</html>
"""

    escaped = html.escape(srcdoc, quote=True)
    return (
        f"<iframe style='width:100%;height:{iframe_height}px;border:0' "
        f"srcdoc=\"{escaped}\"></iframe>"
    )
