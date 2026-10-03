"""Build a GIF/HTML preview and, when available, an MP4 from Traderie screenshots."""

import argparse
import html
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCES = (
    ROOT / "artifacts" / "frames",
    ROOT / "artifacts" / "traderie" / "capture" / "harlequin-crest",
)


def find_source(value):
    if value:
        source = value.resolve()
        if source.is_dir():
            return source
        raise SystemExit(f"Screenshot directory not found: {source}")
    for source in DEFAULT_SOURCES:
        if source.is_dir() and list(source.glob("*.jpg")):
            return source
    choices = " or ".join(str(path.relative_to(ROOT)) for path in DEFAULT_SOURCES)
    raise SystemExit(f"No JPG screenshots found. Pass a source directory (for example {choices}).")


def load_font(size, bold=False):
    windows = Path("C:/Windows/Fonts")
    candidates = (
        [windows / "arialbd.ttf", windows / "segoeuib.ttf"]
        if bold
        else [windows / "arial.ttf", windows / "segoeui.ttf"]
    )
    for path in candidates:
        if path.is_file():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                pass
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, help="Directory containing JPG screenshots")
    parser.add_argument("--output", type=Path, help="Output directory (defaults to <source>/preview)")
    parser.add_argument("--duration", type=int, default=500, help="Milliseconds per GIF frame (default: 500)")
    args = parser.parse_args()
    if args.duration < 1:
        parser.error("--duration must be positive")

    source = find_source(args.source)
    files = sorted(source.glob("*.jpg"))
    if not files:
        raise SystemExit(f"No JPG screenshots found in {source}")
    output = (args.output.resolve() if args.output else source / "preview")
    output.mkdir(parents=True, exist_ok=True)

    title_font = load_font(20, bold=True)
    frames = []
    for path in files:
        with Image.open(path) as image:
            screenshot = image.convert("RGB")
        canvas = Image.new("RGB", (screenshot.width, screenshot.height + 48), "#f3f5f0")
        canvas.paste(screenshot, (0, 48))
        ImageDraw.Draw(canvas).text((16, 13), f"Traderie D2R · {path.stem}", font=title_font, fill="#26392d")
        frames.append(canvas)

    gif = output / "traderie-demo.gif"
    frames[0].save(
        gif,
        save_all=True,
        append_images=frames[1:],
        duration=args.duration,
        loop=0,
        optimize=True,
    )

    # Keep the HTML useful even when ffmpeg is unavailable; it references the source screenshots directly.
    image_paths = [Path(os.path.relpath(path, output)).as_posix() for path in files]
    gallery = "\n".join(
        f'<figure><img src="{html.escape(path, quote=True)}" alt="Traderie screenshot {index}">'
        f"<figcaption>{html.escape(files[index - 1].name)}</figcaption></figure>"
        for index, path in enumerate(image_paths, 1)
    )
    (output / "index.html").write_text(
        "<!doctype html><meta charset=\"utf-8\"><title>Traderie D2R capture preview</title>"
        "<style>body{font:16px Segoe UI,Arial,sans-serif;background:#f3f5f0;color:#26392d;"
        "max-width:1200px;margin:2rem auto}figure{margin:1rem 0}img{max-width:100%;height:auto}"
        "figcaption{color:#647568}</style><h1>Traderie D2R capture preview</h1>"
        f"<p>{len(files)} screenshots from {html.escape(str(source))}</p>{gallery}\n",
        encoding="utf-8",
    )

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        with tempfile.TemporaryDirectory(prefix="traderie-render-") as temporary:
            temp_dir = Path(temporary)
            for index, frame in enumerate(frames):
                frame.save(temp_dir / f"frame-{index:06d}.jpg", quality=90)
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-loglevel",
                    "error",
                    "-framerate",
                    f"{1000 / args.duration:g}",
                    "-i",
                    str(temp_dir / "frame-%06d.jpg"),
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    str(output / "traderie-demo.mp4"),
                ],
                check=True,
            )
        print("Wrote GIF, HTML, and MP4 previews.")
    else:
        print("ffmpeg not found; wrote GIF and HTML previews instead.")
    print(f"Rendered {len(files)} screenshots from {source} to {output}")


if __name__ == "__main__":
    main()
