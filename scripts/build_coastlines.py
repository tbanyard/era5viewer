"""Build the bundled offline coastline data from Natural Earth's public-domain ZIP.

Usage: python scripts/build_coastlines.py ne_50m_coastline.zip
Source: https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_coastline.zip
This development-only tool uses the Python standard library, not a GIS runtime.
"""
import argparse
import json
from pathlib import Path
import struct
from zipfile import ZipFile


def coastlines(path):
    with ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".shp"))
        data = archive.read(name)
    offset, lines = 100, []
    while offset < len(data):
        _, words = struct.unpack_from(">2i", data, offset)
        record = memoryview(data)[offset + 8:offset + 8 + words * 2]
        offset += 8 + words * 2
        shape = struct.unpack_from("<i", record)[0]
        if shape == 0:
            continue
        if shape != 3:
            raise ValueError("Expected a PolyLine shapefile.")
        count, size = struct.unpack_from("<2i", record, 36)
        parts = list(struct.unpack_from("<" + "i" * count, record, 44)) + [size]
        start = 44 + count * 4
        points = [list(struct.unpack_from("<2d", record, start + i * 16)) for i in range(size)]
        for a, b in zip(parts, parts[1:]):
            segment = []
            for lon, lat in points[a:b]:
                if segment and abs(lon - segment[-1][0]) > 180:
                    if len(segment) > 1:
                        lines.append(segment)
                    segment = []
                point = [round(lon, 4), round(lat, 4)]
                if not segment or point != segment[-1]:
                    segment.append(point)
            if len(segment) > 1:
                lines.append(segment)
    return [{"bounds": [min(p[0] for p in line), min(p[1] for p in line),
                         max(p[0] for p in line), max(p[1] for p in line)], "points": line}
            for line in lines]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path)
    args = parser.parse_args()
    payload = {"source": "Natural Earth", "scale": "1:50m", "lines": coastlines(args.zip)}
    output = Path(__file__).resolve().parents[1] / "web" / "coastlines.js"
    output.write_text("/* Natural Earth 1:50m coastline. Public domain. See THIRD_PARTY_NOTICES.md. */\n"
                      "window.ERA5Coastlines=" + json.dumps(payload, separators=(",", ":")) + ";\n")
    print(f"Built {len(payload['lines'])} coastlines, {output.stat().st_size:,} bytes")
