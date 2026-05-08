import pathlib

from .renderer import render_daw_player, generate_spectrogram_image


class Player:
    """Non-interactive SignaVis player with notebook auto-display.

    Works like matplotlib — just return in a cell to show:

    >>> Player("bird.mp3", viewMode="spectrogram")

    Parameters
    ----------
    audio : bytes, str, or pathlib.Path
        Audio data or path to an audio file.
    **kwargs
        Forwarded to ``render_daw_player`` (e.g. ``viewMode``,
        ``spectrogram_data``, ``sample_rate``, ``transportStyle``).
    """

    def __init__(self, audio, **kwargs):
        if isinstance(audio, (str, pathlib.Path)):
            audio = pathlib.Path(audio).read_bytes()
        self._html = render_daw_player(audio, **kwargs)

    def _repr_html_(self):
        return self._html


def show(audio, **kwargs):
    """Display an SignaVis player in the current notebook cell.

    Convenience wrapper — like ``plt.show()``.

    Parameters
    ----------
    audio : bytes, str, or pathlib.Path
        Audio data or path to an audio file.
    **kwargs
        Forwarded to ``render_daw_player``.
    """
    from IPython.display import display, HTML

    if isinstance(audio, (str, pathlib.Path)):
        audio = pathlib.Path(audio).read_bytes()
    display(HTML(render_daw_player(audio, **kwargs)))


try:
    from .widget import AudioWorkbenchWidget
except ImportError:
    # anywidget not installed — widget unavailable, iframe-only mode
    pass

__all__ = ["render_daw_player", "Player", "show", "AudioWorkbenchWidget"]
