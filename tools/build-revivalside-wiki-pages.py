#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import os
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required: pip install pillow") from exc


ROOT = Path(__file__).resolve().parent.parent
WIKI_ROOT = ROOT / "wiki"
ASSET_PREFIX = "/asset-png/"


def parse_args():
    parser = argparse.ArgumentParser(description="Build the static RevivalSide GitHub Pages site")
    parser.add_argument("--asset-root", type=Path, default=ROOT / "extracted-assets" / "all")
    parser.add_argument("--output", type=Path, default=ROOT / "prebuilt" / "revivalside-wiki-pages")
    parser.add_argument("--size", type=int, default=128)
    parser.add_argument("--quality", type=int, default=82)
    return parser.parse_args()


def rewrite(value, assets):
    if isinstance(value, str) and value.startswith(ASSET_PREFIX):
        relative = PurePosixPath(unquote(value[len(ASSET_PREFIX) :]))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"unsafe wiki asset path: {value}")
        output = relative.with_suffix(".webp")
        assets[relative] = output
        return "/".join(["assets", *(quote(part) for part in output.parts)])
    if isinstance(value, list):
        return [rewrite(item, assets) for item in value]
    if isinstance(value, dict):
        return {key: rewrite(item, assets) for key, item in value.items()}
    return value


def convert_image(job):
    source, output, size, quality = job
    output.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        image.save(output, "WEBP", quality=quality, method=4)
    return output.stat().st_size


def main():
    args = parse_args()
    asset_root = args.asset_root.resolve()
    output = args.output.resolve()
    if args.size < 1 or not 1 <= args.quality <= 100:
        raise SystemExit("--size must be positive and --quality must be between 1 and 100")
    if not asset_root.is_dir():
        raise SystemExit(f"wiki asset root was not found: {asset_root}")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    assets = {}
    try:
        for name in ("index.html", "app.js", "styles.css"):
            shutil.copy2(WIKI_ROOT / name, staging / name)
        (staging / ".nojekyll").touch()

        data_output = staging / "data"
        data_output.mkdir()
        for source in sorted((WIKI_ROOT / "data").glob("*.json")):
            payload = rewrite(json.loads(source.read_text(encoding="utf-8")), assets)
            (data_output / source.name).write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )

        jobs = []
        for relative, public_relative in assets.items():
            source = asset_root.joinpath(*relative.parts)
            if not source.is_file():
                raise FileNotFoundError(f"wiki image was not found: {source}")
            jobs.append((source, staging / "assets" / Path(*public_relative.parts), args.size, args.quality))

        total_bytes = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, os.cpu_count() or 1)) as executor:
            for index, size in enumerate(executor.map(convert_image, jobs), 1):
                total_bytes += size
                if index % 500 == 0:
                    print(f"[wiki-pages] converted {index}/{len(jobs)} images")

        if output.exists():
            shutil.rmtree(output)
        staging.replace(output)
        print(
            f"[wiki-pages] wrote {output}: {len(jobs)} images, "
            f"{total_bytes / 1024 / 1024:.1f} MiB of WebP thumbnails"
        )
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


if __name__ == "__main__":
    main()
