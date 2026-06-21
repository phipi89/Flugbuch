from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from time import perf_counter
from urllib.request import urlopen

import joblib
import numpy as np
from pathvalidate import sanitize_filename
from PIL import Image
from scipy.interpolate import RectBivariateSpline


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SWISSALTI3D_INDEX = PROJECT_ROOT / "src" / "swisstopo" / "swissalti3d.csv"
CACHE_DIR = PROJECT_ROOT / "cache" / "alti3d"
WEBGL_TILE_SIZE_M = 1000


@dataclass(frozen=True)
class TerrainGrid:
    x: np.ndarray
    y: np.ndarray
    z: np.ndarray
    normals: np.ndarray


def tile_url(tile_x: int, tile_y: int) -> str:
    for path in np.loadtxt(SWISSALTI3D_INDEX, dtype="str"):
        if f"{tile_x}-{tile_y}" in path:
            return str(path)
    raise ValueError(f"Coordinates {tile_x}-{tile_y} are outside swissALTI3D range.")


@lru_cache(maxsize=512)
def tile_spline(tile_x: int, tile_y: int) -> RectBivariateSpline:
    start = perf_counter()
    url = tile_url(tile_x, tile_y)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path = CACHE_DIR / sanitize_filename(url)

    try:
        spline = joblib.load(cached_path)
        print(f"[terrain] tile {tile_x}-{tile_y} loaded from cache in {(perf_counter() - start) * 1000:.0f} ms", flush=True)
        return spline
    except FileNotFoundError:
        download_start = perf_counter()
        data = np.array(Image.open(urlopen(url))).T
        download_ms = (perf_counter() - download_start) * 1000
        x = np.arange(tile_x * 1000, tile_x * 1000 + 1000, 2)
        y = np.arange(tile_y * 1000, tile_y * 1000 + 1000, 2)
        spline = RectBivariateSpline(x, y, np.fliplr(data))
        joblib.dump(spline, cached_path, compress=True)
        print(
            f"[terrain] tile {tile_x}-{tile_y} downloaded in {download_ms:.0f} ms, total {(perf_counter() - start) * 1000:.0f} ms",
            flush=True,
        )
        return spline


def sample_points(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    start = perf_counter()
    z = np.empty_like(x, dtype=float)
    tile_coords = set(zip((x.ravel() // 1000).astype(int), (y.ravel() // 1000).astype(int)))
    tile_start = perf_counter()
    splines = {coords: tile_spline(*coords) for coords in tile_coords}
    tile_ms = (perf_counter() - tile_start) * 1000

    eval_start = perf_counter()
    for coords, spline in splines.items():
        tile_x, tile_y = coords
        mask = ((x // 1000).astype(int) == tile_x) & ((y // 1000).astype(int) == tile_y)
        z[mask] = spline.ev(x[mask], y[mask])
    eval_ms = (perf_counter() - eval_start) * 1000

    print(
        f"[terrain] sample_points shape={x.shape} tiles={len(tile_coords)} tile_load={tile_ms:.0f} ms eval={eval_ms:.0f} ms total={(perf_counter() - start) * 1000:.0f} ms",
        flush=True,
    )

    return z


def terrain_around_path(
    xy: np.ndarray,
    resolution_m: float = 25,
    margin_m: float | None = None,
    margin_factor: float = 0.75,
) -> TerrainGrid:
    span = float(max(xy[:, 0].ptp(), xy[:, 1].ptp()))
    margin = margin_m if margin_m is not None else max(1000.0, span * margin_factor)
    center = np.array([
        (float(xy[:, 0].min()) + float(xy[:, 0].max())) / 2,
        (float(xy[:, 1].min()) + float(xy[:, 1].max())) / 2,
    ])
    radius = float(np.linalg.norm(xy - center, axis=1).max() + margin)

    x = np.arange(center[0] - radius, center[0] + radius + resolution_m, resolution_m)
    y = np.arange(center[1] - radius, center[1] + radius + resolution_m, resolution_m)
    xx, yy = np.meshgrid(x, y, indexing="xy")
    z = sample_points(xx, yy)

    dz_dy, dz_dx = np.gradient(z, resolution_m, resolution_m)
    normals = np.dstack((-dz_dx, -dz_dy, np.ones_like(z)))
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)

    return TerrainGrid(x=x, y=y, z=z, normals=normals)


def adaptive_terrain_around_path(
    xy: np.ndarray,
    margin_m: float = 1000,
    min_resolution_m: float = 5,
    max_resolution_m: float = 50,
    max_grid_side: int = 1100,
) -> TerrainGrid:
    """Sample terrain around a path at the sharpest interactive resolution."""

    center = np.array([
        (float(xy[:, 0].min()) + float(xy[:, 0].max())) / 2,
        (float(xy[:, 1].min()) + float(xy[:, 1].max())) / 2,
    ])
    diameter = 2 * float(np.linalg.norm(xy - center, axis=1).max() + margin_m)
    resolution = diameter / max_grid_side
    resolution = float(np.clip(resolution, min_resolution_m, max_resolution_m))
    return terrain_around_path(xy, resolution_m=resolution, margin_m=margin_m)


def full_flight_circle(xy: np.ndarray, margin_m: float = 300) -> tuple[np.ndarray, float]:
    center = np.array([
        (float(xy[:, 0].min()) + float(xy[:, 0].max())) / 2,
        (float(xy[:, 1].min()) + float(xy[:, 1].max())) / 2,
    ])
    radius = float(np.linalg.norm(xy - center, axis=1).max() + margin_m)
    return center, radius


def clamp_circle_center(point: np.ndarray, full_center: np.ndarray, full_radius: float, radius: float) -> np.ndarray:
    max_distance = max(0.0, full_radius - radius)
    delta = point - full_center
    distance = float(np.linalg.norm(delta))
    if distance <= max_distance or distance == 0:
        return point.astype(float)
    return full_center + delta / distance * max_distance


def local_terrain_resolution(radius_m: float) -> float:
    if radius_m >= 6000:
        return 25.0
    if radius_m >= 3000:
        return 15.0
    return 5.0


def terrain_around_center(center: np.ndarray, radius_m: float, resolution_m: float) -> TerrainGrid:
    start = perf_counter()
    x = np.arange(center[0] - radius_m, center[0] + radius_m + resolution_m, resolution_m)
    y = np.arange(center[1] - radius_m, center[1] + radius_m + resolution_m, resolution_m)
    xx, yy = np.meshgrid(x, y, indexing="xy")
    sample_radius = radius_m + 2 * resolution_m
    sample_mask = (xx - center[0]) ** 2 + (yy - center[1]) ** 2 <= sample_radius**2
    sample_start = perf_counter()
    z = np.full_like(xx, np.nan, dtype=float)
    z[sample_mask] = sample_points(xx[sample_mask], yy[sample_mask])
    sample_ms = (perf_counter() - sample_start) * 1000
    z = np.where(np.isnan(z), np.nanmean(z), z)

    gradient_start = perf_counter()
    dz_dy, dz_dx = np.gradient(z, resolution_m, resolution_m)
    normals = np.dstack((-dz_dx, -dz_dy, np.ones_like(z)))
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)
    gradient_ms = (perf_counter() - gradient_start) * 1000
    print(
        f"[terrain] terrain_around_center radius={radius_m:.0f}m resolution={resolution_m:.0f}m grid={len(x)}x{len(y)} sampled={int(sample_mask.sum())}/{sample_mask.size} sample={sample_ms:.0f} ms normals={gradient_ms:.0f} ms total={(perf_counter() - start) * 1000:.0f} ms",
        flush=True,
    )
    return TerrainGrid(x=x, y=y, z=z, normals=normals)


def webgl_tile_payload(tile_x0: float, tile_y0: float, resolution_m: float, tile_size_m: int = WEBGL_TILE_SIZE_M) -> dict:
    start = perf_counter()
    x0 = float(tile_x0)
    y0 = float(tile_y0)
    resolution = float(resolution_m)
    x = np.arange(x0, x0 + tile_size_m + resolution, resolution)
    y = np.arange(y0, y0 + tile_size_m + resolution, resolution)
    xx, yy = np.meshgrid(x, y, indexing="xy")

    sample_start = perf_counter()
    z = sample_points(xx, yy)
    sample_ms = (perf_counter() - sample_start) * 1000
    total_ms = (perf_counter() - start) * 1000
    print(
        f"[terrain] tile_payload x0={x0:.0f} y0={y0:.0f} resolution={resolution:.0f}m grid={len(x)}x{len(y)} sample={sample_ms:.0f} ms total={total_ms:.0f} ms",
        flush=True,
    )

    return {
        "tile": {
            "x0": x0,
            "y0": y0,
            "size": tile_size_m,
            "resolution": resolution,
            "width": int(len(x)),
            "height": int(len(y)),
            "z": z.astype(float).ravel().tolist(),
            "zMin": float(np.nanmin(z)),
            "zMax": float(np.nanmax(z)),
        },
        "timing": {
            "sampleMs": round(sample_ms, 1),
            "totalMs": round(total_ms, 1),
        },
    }


def webgl_terrain_payload(
    terrain: TerrainGrid,
    flight_xyz: np.ndarray,
    sun_azimuth: np.ndarray,
    max_grid_side: int = 320,
    max_path_points: int = 1800,
) -> dict:
    """Build a compact JSON-serializable terrain payload for browser rendering."""

    xy = flight_xyz[:, :2]
    center = np.array([
        (float(xy[:, 0].min()) + float(xy[:, 0].max())) / 2,
        (float(xy[:, 1].min()) + float(xy[:, 1].max())) / 2,
    ])
    radius = float(np.linalg.norm(xy - center, axis=1).max() + 300)

    terrain_step = max(1, int(np.ceil(max(len(terrain.x), len(terrain.y)) / max_grid_side)))
    x = terrain.x[::terrain_step]
    y = terrain.y[::terrain_step]
    z = terrain.z[::terrain_step, ::terrain_step]

    path_step = max(1, int(np.ceil(len(flight_xyz) / max_path_points)))
    path = flight_xyz[::path_step]

    return {
        "terrain": {
            "x0": float(x[0]),
            "y0": float(y[0]),
            "dx": float(np.mean(np.diff(x))) if len(x) > 1 else 1.0,
            "dy": float(np.mean(np.diff(y))) if len(y) > 1 else 1.0,
            "width": int(len(x)),
            "height": int(len(y)),
            "z": z.astype(float).ravel().tolist(),
            "zMin": float(np.nanmin(z)),
            "zMax": float(np.nanmax(z)),
        },
        "circle": {
            "center": center.astype(float).tolist(),
            "radius": radius,
        },
        "flightPath": path.astype(float).tolist(),
        "sun": {
            "startAzimuth": float(sun_azimuth[0]),
            "endAzimuth": float(sun_azimuth[-1]),
        },
    }


def webgl_local_terrain_payload(
    flight_xyz: np.ndarray,
    sun_azimuth: np.ndarray,
    focus_index: int,
    radius_m: float,
    min_radius_m: float = 1500,
) -> dict:
    start = perf_counter()
    xy = flight_xyz[:, :2]
    geometry_start = perf_counter()
    full_center, full_radius = full_flight_circle(xy)
    radius = float(np.clip(radius_m, min_radius_m, full_radius))
    focus_index = int(np.clip(focus_index, 0, len(flight_xyz) - 1))
    center = clamp_circle_center(flight_xyz[focus_index, :2], full_center, full_radius, radius)
    resolution = local_terrain_resolution(radius)
    geometry_ms = (perf_counter() - geometry_start) * 1000
    terrain_start = perf_counter()
    terrain = terrain_around_center(center, radius, resolution)
    terrain_ms = (perf_counter() - terrain_start) * 1000
    payload_start = perf_counter()
    payload = webgl_terrain_payload(terrain, flight_xyz, sun_azimuth, max_grid_side=max(len(terrain.x), len(terrain.y)))
    payload_ms = (perf_counter() - payload_start) * 1000

    result = {
        **payload,
        "circle": {
            "center": center.astype(float).tolist(),
            "radius": radius,
        },
        "fullCircle": {
            "center": full_center.astype(float).tolist(),
            "radius": full_radius,
        },
        "focusIndex": focus_index,
        "resolution": resolution,
        "minRadius": min_radius_m,
        "maxRadius": full_radius,
        "timing": {
            "geometryMs": round(geometry_ms, 1),
            "terrainMs": round(terrain_ms, 1),
            "payloadMs": round(payload_ms, 1),
            "totalMs": round((perf_counter() - start) * 1000, 1),
        },
    }
    print(
        "[terrain] local_payload "
        f"geometry={geometry_ms:.0f} ms terrain={terrain_ms:.0f} ms payload={payload_ms:.0f} ms total={(perf_counter() - start) * 1000:.0f} ms",
        flush=True,
    )
    return result


def terrain_heights(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return sample_points(np.asarray(x), np.asarray(y))


def sun_exposure(normals: np.ndarray, sun_direction: np.ndarray) -> np.ndarray:
    return np.clip(np.tensordot(normals, sun_direction, axes=([2], [0])), 0, 1)
