from __future__ import annotations

import gzip
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from time import perf_counter
from urllib.request import Request, urlopen

import mapbox_vector_tile
import mercantile
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely import box
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, shape
from shapely.ops import transform

from .terrain import WEBGL_TILE_CACHE_DIR


VECTOR_TILE_URL = "https://vectortiles{server}.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf"
WATER_COLOR = (120, 185, 225, 155)
FOREST_COLOR = (145, 190, 130, 115)
FOREST_CLASSES = {"forest", "wood"}
FOREST_SUBCLASSES = {"forest", "wood", "loose_forest", "scrub", "woody_plant"}

LV95_TO_WGS84 = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)
WEBMERCATOR_TO_LV95 = Transformer.from_crs("EPSG:3857", "EPSG:2056", always_xy=True)


def pick_vector_zoom(resolution_m: float) -> int:
    if resolution_m >= 50:
        return 10
    if resolution_m >= 25:
        return 11
    if resolution_m >= 10:
        return 12
    return 13


def overlay_cache_key(x0: float, y0: float, width: int, height: int, resolution_m: float, zoom: int) -> Path:
    name = f"overlay_z{zoom}_r{resolution_m:g}_w{width}_h{height}_x{int(x0)}_y{int(y0)}.png"
    return WEBGL_TILE_CACHE_DIR / name


@lru_cache(maxsize=512)
def _fetch_vector_tile(z: int, x: int, y: int) -> bytes | None:
    server = (x + y) % 5
    url = VECTOR_TILE_URL.format(server=server, z=z, x=x, y=y)
    try:
        response = urlopen(Request(url, headers={"Accept-Encoding": "gzip"}), timeout=10)
        data = response.read()
        if response.headers.get("Content-Encoding") == "gzip" or data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        return data
    except Exception as e:
        print(f"[landcover] vector tile failed z={z} x={x} y={y}: {e}", flush=True)
        return None


@lru_cache(maxsize=512)
def _decode_vector_tile(z: int, x: int, y: int) -> dict | None:
    data = _fetch_vector_tile(z, x, y)
    if data is None:
        return None
    return mapbox_vector_tile.decode(data, default_options={"geojson": False, "y_coord_down": True})


def _tile_transformer(z: int, x: int, y: int, extent: int):
    bounds = mercantile.xy_bounds(x, y, z)
    width = bounds.right - bounds.left
    height = bounds.top - bounds.bottom

    def to_lv95(local_x: float, local_y: float) -> tuple[float, float]:
        wm_x = bounds.left + local_x / extent * width
        wm_y = bounds.top - local_y / extent * height
        return WEBMERCATOR_TO_LV95.transform(wm_x, wm_y)

    return to_lv95


def _iter_polygons(geom):
    if geom.is_empty:
        return
    if isinstance(geom, Polygon):
        yield geom
    elif isinstance(geom, MultiPolygon):
        yield from geom.geoms
    elif isinstance(geom, GeometryCollection):
        for child in geom.geoms:
            yield from _iter_polygons(child)


def _draw_polygon(draw: ImageDraw.ImageDraw, poly: Polygon, x0: float, y0: float, ymax: float, scale: float, color: tuple[int, int, int, int]) -> None:
    def to_px(coords):
        return [(round((x - x0) / scale), round((ymax - y) / scale)) for x, y in coords]

    exterior = to_px(poly.exterior.coords)
    if len(exterior) >= 3:
        draw.polygon(exterior, fill=color)
    for ring in poly.interiors:
        hole = to_px(ring.coords)
        if len(hole) >= 3:
            draw.polygon(hole, fill=(0, 0, 0, 0))


def _feature_color(layer_name: str, properties: dict) -> tuple[int, int, int, int] | None:
    if layer_name == "water":
        return WATER_COLOR
    if layer_name == "landcover":
        klass = properties.get("class")
        subclass = properties.get("subclass")
        if klass in FOREST_CLASSES or subclass in FOREST_SUBCLASSES:
            return FOREST_COLOR
    return None


def landcover_overlay(x0: float, y0: float, width: int, height: int, resolution_m: float) -> bytes | None:
    start = perf_counter()
    zoom = pick_vector_zoom(resolution_m)
    cached_path = overlay_cache_key(x0, y0, width, height, resolution_m, zoom)
    try:
        return cached_path.read_bytes()
    except FileNotFoundError:
        pass

    xmax = x0 + (width - 1) * resolution_m
    ymax = y0 + (height - 1) * resolution_m
    lonlat = [LV95_TO_WGS84.transform(x, y) for x, y in [(x0, y0), (x0, ymax), (xmax, y0), (xmax, ymax)]]
    west = min(p[0] for p in lonlat)
    east = max(p[0] for p in lonlat)
    south = min(p[1] for p in lonlat)
    north = max(p[1] for p in lonlat)
    tiles = list(mercantile.tiles(west, south, east, north, [zoom]))

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")
    clip = box(x0, y0, xmax, ymax)
    feature_count = 0

    for tile in tiles:
        decoded = _decode_vector_tile(tile.z, tile.x, tile.y)
        if decoded is None:
            continue
        for layer_name in ("landcover", "water"):
            layer = decoded.get(layer_name)
            if not layer:
                continue
            extent = int(layer.get("extent", 4096))
            to_lv95 = _tile_transformer(tile.z, tile.x, tile.y, extent)
            for feature in layer.get("features", []):
                color = _feature_color(layer_name, feature.get("properties", {}))
                if color is None:
                    continue
                geom_data = feature.get("geometry")
                if not geom_data:
                    continue
                try:
                    geom = transform(to_lv95, shape(geom_data)).intersection(clip)
                except Exception:
                    continue
                for poly in _iter_polygons(geom):
                    if poly.area > 1:
                        _draw_polygon(draw, poly, x0, y0, ymax, resolution_m, color)
                        feature_count += 1

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    data = buffer.getvalue()
    WEBGL_TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path.write_bytes(data)
    print(
        f"[landcover] overlay {width}x{height} z={zoom} x0={x0:.0f} y0={y0:.0f} tiles={len(tiles)} features={feature_count} total={(perf_counter() - start) * 1000:.0f} ms",
        flush=True,
    )
    return data
