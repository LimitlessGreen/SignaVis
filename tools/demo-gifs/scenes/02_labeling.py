"""Draw a box around a call and name it."""

SCENE = {
    "name": "labeling",
    "title": "Draw a label box around a call and name it",
    "viewport": (1440, 810),
}


def run(d):
    d.setup_recording()
    d.narrow_freq()
    d.click('button[title="Show less time (zoom in)"]', ms=1500)
    d.begin()

    d.caption("Draw a box around a call", 600)
    x0, y0 = d.at(0.36, 0.12)
    x1, y1 = d.at(0.43, 0.86)
    d.drag(x0, y0, x1, y1, steps=40, ms=900)

    d.caption("Assign the species")
    search = d.pg.locator(".label-search-input").first
    if search.is_visible():
        d.type("Tree Pip", delay=110)
        d.wait(900)
        d.pg.keyboard.press("ArrowDown")  # pick the species from the list, not free text
        d.wait(500)
        d.pg.keyboard.press("Enter")
        d.wait(500)
        save = d.pg.locator("button", has_text="Save").filter(visible=True).first
        if save.count():
            d.click(save, ms=600)
    d.move(*d.at(0.7, 0.5))
    d.caption("The annotation appears on the spectrogram and in the list", 2200)
    d.no_caption()
