from __future__ import annotations

from functools import lru_cache
from io import BytesIO
from pathlib import Path
from time import perf_counter
from urllib.request import urlopen

import numpy as np
from PIL import Image

from .terrain import WEBGL_TILE_CACHE_DIR

# LV95 WMTS tile matrix
ORIGIN_X = 2_420_000
ORIGIN_Y = 1_350_000
WMTS_TILE_PX = 256

# scale → ground width of one tile in meters
# 18: 12800m (50 m/px), 19: 5120m (20 m/px),
# 20: 2560m (10 m/px), 21: 1280m (5 m/px), 22: 640m (2.5 m/px)
SCALE_TILE_WIDTH = {18: 12800, 19: 5120, 20: 2560, 21: 1280, 22: 640}


def pick_scale(resolution_m: float) -> int:
    return min(SCALE_TILE_WIDTH,
               key=lambda s: abs(SCALE_TILE_WIDTH[s] / WMTS_TILE_PX - resolution_m))


WMTS_LAYERS = {
    "swissimage": "ch.swisstopo.swissimage",
    "pixelkarte": "ch.swisstopo.pixelkarte-farbe",
}


def texture_cache_key(x0: float, y0: float, size_m: int, resolution_m: float, layer: str) -> Path:
    name = f"tex_{layer}_s{size_m}_r{resolution_m:g}_x{int(x0)}_y{int(y0)}.jpg"
    return WEBGL_TILE_CACHE_DIR / name


def download_wmts_tile(row: int, col: int, scale: int, layer: str) -> Image.Image:
    # EPSG:2056 uses col/row order in the URL (unlike EPSG:21781 which uses row/col)
    url = f"https://wmts.geo.admin.ch/1.0.0/{WMTS_LAYERS[layer]}/default/current/2056/{scale}/{col}/{row}.jpeg"
    resp = urlopen(url, timeout=10)
    return Image.open(BytesIO(resp.read()))


def _build_texture(x0: float, y0: float, size_m: int, resolution_m: float,
                   scale: int, tw: int, img_px: int, layer: str) -> bytes:
    col0 = int((x0 - ORIGIN_X) // tw)
    col1 = int((x0 + size_m - 1 - ORIGIN_X) // tw)
    row0 = int((ORIGIN_Y - (y0 + size_m)) // tw)
    row1 = int((ORIGIN_Y - y0) // tw)

    if col0 == col1 and row0 == row1:
        tile = download_wmts_tile(row0, col0, scale, layer)
        tile_x0 = ORIGIN_X + col0 * tw
        tile_y1 = ORIGIN_Y - row0 * tw
        px = int(round((x0 - tile_x0) / tw * WMTS_TILE_PX))
        py = int(round((tile_y1 - (y0 + size_m)) / tw * WMTS_TILE_PX))
        tile = tile.crop((px, py, px + img_px, py + img_px))
    else:
        n_cols = col1 - col0 + 1
        n_rows = row1 - row0 + 1
        tiles = [[download_wmts_tile(r, c, scale, layer) for c in range(col0, col1 + 1)]
                 for r in range(row0, row1 + 1)]
        full_w = n_cols * WMTS_TILE_PX
        full_h = n_rows * WMTS_TILE_PX
        canvas = Image.new("RGB", (full_w, full_h))
        for r, row_tiles in enumerate(tiles):
            for c, tile_img in enumerate(row_tiles):
                canvas.paste(tile_img, (c * WMTS_TILE_PX, r * WMTS_TILE_PX))
        tile_x0 = ORIGIN_X + col0 * tw
        tile_y1 = ORIGIN_Y - row0 * tw
        px = int(round((x0 - tile_x0) / tw * full_w))
        py = int(round((tile_y1 - (y0 + size_m)) / tw * full_h))
        tile = canvas.crop((px, py, px + img_px, py + img_px))

    buf = BytesIO()
    tile.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def texture_for_tile(x0: float, y0: float, size_m: int, resolution_m: float,
                     layer: str = "swissimage") -> bytes | None:
    start = perf_counter()
    cached_path = texture_cache_key(x0, y0, size_m, resolution_m, layer)
    try:
        data = cached_path.read_bytes()
        print(f"[imagery] cache hit {cached_path.name} ({len(data)} bytes) in {(perf_counter() - start) * 1000:.0f} ms",
              flush=True)
        return data
    except FileNotFoundError:
        pass

    scale = pick_scale(resolution_m)
    tw = SCALE_TILE_WIDTH[scale]
    img_px = int(round(size_m / resolution_m))

    source = "downloaded"
    try:
        data = _build_texture(x0, y0, size_m, resolution_m, scale, tw, img_px, layer)
    except Exception as e:
        print(f"[imagery] failed for {cached_path.name}: {e}", flush=True)
        return None

    WEBGL_TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path.write_bytes(data)
    ms = (perf_counter() - start) * 1000
    print(f"[imagery] {source} {cached_path.name} ({len(data)} bytes, scale={scale}, img={img_px}px) in {ms:.0f} ms",
          flush=True)
    return data
