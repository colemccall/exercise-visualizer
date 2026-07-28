#!/usr/bin/env python3
"""
prepare_photos.py — optional offline EXIF extractor for the fitness visualizer.

Walks a folder of photos, reads EXIF timestamp + GPS from each, and writes
a `data/photos.json` file next to the app plus copies the photos into
`photos/`. On next load, parsers/photos.js will pick up this JSON and skip
the (slow) live EXIF pass — useful for very large libraries.

Matching itself still runs in-browser so this script has zero knowledge of
your workouts.

Usage:
    python scripts/prepare_photos.py <photo-folder> [--out .]

Requirements:
    pip install Pillow exifread
"""
import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import exifread  # type: ignore
except ImportError:
    print("Missing dependency: pip install exifread Pillow", file=sys.stderr)
    sys.exit(1)


IMAGE_EXTS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp"}


def _to_deg(ratios, ref):
    d, m, s = [float(r.num) / float(r.den) for r in ratios]
    val = d + m / 60.0 + s / 3600.0
    if ref in ("S", "W"):
        val = -val
    return val


def _extract(path: Path):
    with path.open("rb") as fh:
        tags = exifread.process_file(fh, details=False)

    ts_tag = tags.get("EXIF DateTimeOriginal") or tags.get("Image DateTime")
    timestamp = None
    if ts_tag:
        try:
            timestamp = datetime.strptime(str(ts_tag), "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    lat_tag = tags.get("GPS GPSLatitude")
    lat_ref = tags.get("GPS GPSLatitudeRef")
    lng_tag = tags.get("GPS GPSLongitude")
    lng_ref = tags.get("GPS GPSLongitudeRef")

    lat = lng = None
    if lat_tag and lat_ref and lng_tag and lng_ref:
        try:
            lat = _to_deg(lat_tag.values, str(lat_ref))
            lng = _to_deg(lng_tag.values, str(lng_ref))
        except Exception:
            pass

    tz_offset = tags.get("EXIF OffsetTimeOriginal") or tags.get("EXIF OffsetTime")

    return {
        "file": path.name,
        "timestamp": timestamp.isoformat() if timestamp else None,
        "tzOffset": str(tz_offset) if tz_offset else None,
        "lat": lat,
        "lng": lng,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path, help="Folder containing photos")
    ap.add_argument("--out", type=Path, default=Path("."), help="App root directory (default: cwd)")
    args = ap.parse_args()

    if not args.folder.is_dir():
        sys.exit(f"Not a directory: {args.folder}")

    photos_out = args.out / "photos"
    data_out   = args.out / "data"
    photos_out.mkdir(parents=True, exist_ok=True)
    data_out.mkdir(parents=True, exist_ok=True)

    records = []
    for path in sorted(args.folder.rglob("*")):
        if path.suffix.lower() not in IMAGE_EXTS or not path.is_file():
            continue
        try:
            rec = _extract(path)
        except Exception as exc:
            print(f"[warn] {path.name}: {exc}", file=sys.stderr)
            continue
        # Copy into photos/ using a flat name (add parent-dir suffix if collision)
        target = photos_out / path.name
        if target.exists() and target.stat().st_size != path.stat().st_size:
            target = photos_out / f"{path.parent.name}__{path.name}"
            rec["file"] = target.name
        if not target.exists():
            shutil.copy2(path, target)
        records.append(rec)
        print(f"  {rec['file']}  ts={rec['timestamp']}  gps={rec['lat'] is not None}")

    out_json = data_out / "photos.json"
    with out_json.open("w", encoding="utf-8") as fh:
        json.dump(records, fh, indent=2)
    print(f"\nWrote {len(records)} photo records to {out_json}")


if __name__ == "__main__":
    main()
