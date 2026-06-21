from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.request import urlopen

import joblib
import numpy as np
from pathvalidate import sanitize_filename
from PIL import Image
from scipy.interpolate import RectBivariateSpline


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SWISSALTI3D_INDEX = PROJECT_ROOT / "src" / "swisstopo" / "swissalti3d.csv"
CACHE_DIR = PROJECT_ROOT / "cache" / "alti3d"


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


def tile_spline(tile_x: int, tile_y: int) -> RectBivariateSpline:
    url = tile_url(tile_x, tile_y)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path = CACHE_DIR / sanitize_filename(url)

    try:
        return joblib.load(cached_path)
    except FileNotFoundError:
        data = np.array(Image.open(urlopen(url))).T
        x = np.arange(tile_x * 1000, tile_x * 1000 + 1000, 2)
        y = np.arange(tile_y * 1000, tile_y * 1000 + 1000, 2)
        spline = RectBivariateSpline(x, y, np.fliplr(data))
        joblib.dump(spline, cached_path, compress=True)
        return spline


def sample_points(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    z = np.empty_like(x, dtype=float)
    tile_coords = set(zip((x.ravel() // 1000).astype(int), (y.ravel() // 1000).astype(int)))
    splines = {coords: tile_spline(*coords) for coords in tile_coords}

    for coords, spline in splines.items():
        tile_x, tile_y = coords
        mask = ((x // 1000).astype(int) == tile_x) & ((y // 1000).astype(int) == tile_y)
        z[mask] = spline.ev(x[mask], y[mask])

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


def terrain_heights(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return sample_points(np.asarray(x), np.asarray(y))


def sun_exposure(normals: np.ndarray, sun_direction: np.ndarray) -> np.ndarray:
    return np.clip(np.tensordot(normals, sun_direction, axes=([2], [0])), 0, 1)
