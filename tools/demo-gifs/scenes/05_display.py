"""Display panel: presets, time/frequency trade-off and colour maps."""

SCENE = {
    "name": "display",
    "title": "Spectrogram presets, time/frequency resolution and colours",
    "viewport": (1440, 810),
}


def select(d, label_text, value, ms=1500):
    """Choose an option in a <select> of the Display panel (identified by one of its option labels)."""
    sel = d.pg.locator("select.settings-select").filter(has=d.pg.locator(f'option[value="{value}"]')).first
    d.hover(sel, 300)
    sel.select_option(value)
    d.wait(ms)


def run(d):
    d.setup_recording()
    d.open_panel("spectrogram", click=False)
    d.wait(800)
    d.begin()

    d.caption("Presets — e.g. the look of Xeno-canto …")
    select(d, "Preset", "xc")
    d.caption("… Perch …")
    select(d, "Preset", "perch")
    d.caption("… or Classic")
    select(d, "Preset", "classic")

    d.caption("One slider trades time against frequency resolution")
    # The time ↔ frequency slider is the topmost range input in the right-hand panel
    vw = d.pg.viewport_size["width"]
    ranges = [r.bounding_box() for r in d.pg.locator("input[type=range]").filter(visible=True).all()]
    ranges = sorted((b for b in ranges if b and b["x"] > vw * 0.6), key=lambda b: b["y"])
    if ranges:
        b = ranges[0]
        y = b["y"] + b["height"] / 2
        d.drag(b["x"] + b["width"] * 0.5, y, b["x"] + b["width"] * 0.1, y, steps=25, ms=1300)
        d.drag(d.x, y, b["x"] + b["width"] * 0.9, y, steps=40, ms=1300)
        d.drag(d.x, y, b["x"] + b["width"] * 0.5, y, steps=25, ms=900)

    d.caption("Colour maps")
    for cmap in ("inferno", "viridis", "grayscaleInv", "xenocanto"):
        select(d, "Color", cmap, ms=1000)
    d.no_caption()
