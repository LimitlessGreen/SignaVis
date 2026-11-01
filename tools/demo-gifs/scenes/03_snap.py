"""Snap to call: click a call → the box follows its outline; Shift+wheel tunes the sensitivity;
a second click inside the box adds it."""

SCENE = {
    "name": "snap",
    "title": "Snap to call: one click boxes a call",
    "viewport": (1440, 810),
}

SNAP_BTN = 'button[title^="Snap to call"]'


def probe(d, fx, fy):
    """Click once in snap mode (before begin(), cut from the GIF); True if a box preview appears."""
    d.pg.mouse.click(*d.at(fx, fy))
    d.wait(150)
    ok = d.pg.locator(".snap-preview").count() > 0
    d.pg.keyboard.press("Escape")          # leaves snap mode without adding anything
    d.wait(60)
    d.pg.locator(SNAP_BTN).click()
    d.wait(60)
    return ok


def find_targets(d, n=1):
    """n call positions, spread over time, where Snap locks on."""
    found = []
    for i in range(16):
        fx = 0.22 + 0.5 * i / 15
        if found and fx - found[-1][0] < 0.1:
            continue
        for fy in (0.55, 0.65, 0.45, 0.75, 0.35):
            if probe(d, fx, fy):
                found.append((fx, fy))
                break
        if len(found) == n:
            break
    return found


def run(d):
    d.setup_recording()
    d.click('button[title="Show less time (zoom in)"]', ms=1500)
    d.pg.locator(SNAP_BTN).click()
    targets = find_targets(d) or [(0.39, 0.62), (0.52, 0.55), (0.66, 0.58)]
    d.pg.keyboard.press("Escape")
    d.wait(400)
    d.begin()

    d.caption("<b>Snap</b>: click a call …")
    d.click(SNAP_BTN, ms=400)
    d.move(*d.at(*targets[0]), steps=40)
    d.click(ms=1300)

    d.caption("<kbd>Shift</kbd> + wheel adjusts the sensitivity")
    d.wheel(-120, times=4, modifier="Shift", ms=350)
    d.wheel(120, times=4, modifier="Shift", ms=350)
    d.wait(500)

    d.caption("A second click adds the box")
    d.click(ms=1000)
    if d.pg.locator(".label-search-input").first.is_visible():
        d.type("Zosterops borbonicus", delay=70)
        d.wait(500)
        d.pg.keyboard.press("Enter")
        d.wait(600)
    d.move(*d.at(0.9, 0.5))
    d.caption("Exact boxes without drawing by hand", 2000)
    d.no_caption()
