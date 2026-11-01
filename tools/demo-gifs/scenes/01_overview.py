"""Load → play → zoom and scroll in time → fit the frequency range."""

SCENE = {
    "name": "overview",
    "title": "Waveform + spectrogram: play, zoom, scroll, auto frequency range",
    "viewport": (1440, 810),
}


def run(d):
    d.setup_recording()
    d.begin()

    d.caption("Waveform and spectrogram of your recording", 1600)
    d.caption("Play with <kbd>Space</kbd>")
    d.click('button[title^="Play / Pause"]', ms=2500)
    d.click('button[title^="Play / Pause"]', ms=400)

    d.caption("Zoom in time …")
    for _ in range(2):
        d.click('button[title="Show less time (zoom in)"]', ms=500)
    d.wait(400)

    d.caption("… and scroll with the mouse wheel")
    d.move(*d.at(0.5, 0.5))
    d.wheel(240, times=8, modifier="Shift")
    d.wait(300)
    d.wheel(-240, times=4, modifier="Shift")
    d.wait(500)

    d.caption("<b>Auto</b> fits the frequency range to the calls")
    d.click('button[title="Fit the frequency range to where the calls are"]', ms=1600)

    d.caption("<b>Fit</b> shows the whole recording again")
    d.click('button[title="Fit to view"]', ms=1500)
    d.no_caption()
