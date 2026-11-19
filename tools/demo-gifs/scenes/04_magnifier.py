"""Magnifier: drag a field to zoom into time and frequency at once; right-click goes back."""

SCENE = {
    "name": "magnifier",
    "title": "Magnifier: zoom into a field, right-click to go back",
    "viewport": (1440, 810),
}


def run(d):
    d.setup_recording()
    d.narrow_freq()
    d.begin()

    d.caption("<b>Zoom</b>: drag a region …")
    d.click(d.toolbar_button("Zoom"), ms=500)
    x0, y0 = d.at(0.40, 0.25)
    x1, y1 = d.at(0.58, 0.75)
    d.drag(x0, y0, x1, y1, steps=40, ms=1800)

    d.caption("… and again, down to individual elements")
    x0, y0 = d.at(0.30, 0.30)
    x1, y1 = d.at(0.62, 0.80)
    d.drag(x0, y0, x1, y1, steps=40, ms=1800)

    d.caption("Right-click returns to the previous view")
    d.click(button="right", ms=1300)
    d.click(button="right", ms=1300)
    d.pg.keyboard.press("Escape")
    d.no_caption()
