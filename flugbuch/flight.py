from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import date, datetime
from glob import glob
from pathlib import Path

import circle_fit
import numpy as np
import scipy.ndimage
from suncalc import get_position

from .coordinates import wgs84_to_lv95
from .terrain import terrain_heights


PROJECT_ROOT = Path(__file__).resolve().parents[1]
IGCLIB_PATH = PROJECT_ROOT / "IGClib"
if str(IGCLIB_PATH) not in sys.path:
    sys.path.insert(0, str(IGCLIB_PATH))

import igc_lib  # noqa: E402


@dataclass(frozen=True)
class LaunchSite:
    name: str
    position: np.ndarray


LAUNCH_SITES = [
    LaunchSite("Gurli", np.array([2_588_081, 1_173_604, 1408.6])),
    LaunchSite("Schwarzsee, Riggisalp", np.array([2_588_910, 1_167_592, 1470.5])),
    LaunchSite("Hohmattli", np.array([2_590_782, 1_168_724, 1782.6])),
    LaunchSite("Charmey, Vounetz", np.array([2_582_200, 1_163_814, 1610.4])),
    LaunchSite("Möntschele", np.array([2_605_439, 1_173_806, 1401.9])),
    LaunchSite("Grandvillard, Les Merlas", np.array([2_575_600, 1_154_901, 1742.6])),
]


@dataclass
class Flight:
    path: Path
    raw: object
    date: date
    lat: np.ndarray
    lon: np.ndarray
    altitude: np.ndarray
    xyz: np.ndarray
    terrain_altitude: np.ndarray
    time: np.ndarray
    velocity: np.ndarray
    ground_speed_ms: np.ndarray
    sun_azimuth: np.ndarray
    sun_direction: np.ndarray
    mean_sun_direction: np.ndarray
    wind_vector_ms: np.ndarray
    mean_airspeed_ms: float
    launch_site: LaunchSite | None

    @property
    def x(self) -> np.ndarray:
        return self.xyz[:, 0]

    @property
    def y(self) -> np.ndarray:
        return self.xyz[:, 1]

    @property
    def z(self) -> np.ndarray:
        return self.xyz[:, 2]

    @property
    def xy(self) -> np.ndarray:
        return self.xyz[:, :2]

    @property
    def duration_seconds(self) -> float:
        return float((self.time[-1] - self.time[0]).total_seconds())

    @property
    def height_above_ground(self) -> np.ndarray:
        return self.z - self.terrain_altitude

    @property
    def wind_speed_kmh(self) -> float:
        return float(np.linalg.norm(self.wind_vector_ms) * 3.6)

    @property
    def wind_from_degrees(self) -> float:
        x, y = self.wind_vector_ms
        return float((np.rad2deg(np.arctan2(-x, -y)) + 360) % 360)

    @property
    def title(self) -> str:
        site = self.launch_site.name if self.launch_site else "unknown launch"
        return f"{self.date.isoformat()} - {site} - {self.path.name}"


def load_flight(path: str | Path) -> Flight:
    path = Path(path)
    raw = igc_lib.Flight.create_from_file(path)
    if not raw.valid:
        raise ValueError(f"Invalid IGC file {path}: {'; '.join(raw.notes)}")
    if (path.parent / "ignore").exists():
        raise ValueError(f"Ignored flight {path}")

    lat = np.array([fix.lat for fix in raw.fixes])
    lon = np.array([fix.lon for fix in raw.fixes])
    altitude = np.array([fix.gnss_alt for fix in raw.fixes])

    xyz = np.array([wgs84_to_lv95(fix.lat, fix.lon, fix.gnss_alt) for fix in raw.fixes])
    xyz = scipy.ndimage.gaussian_filter1d(xyz, sigma=0.5, axis=0)

    terrain_altitude = terrain_heights(xyz[:, 0], xyz[:, 1])
    start_offset = terrain_altitude[:5].mean() - xyz[:5, 2].mean()
    end_offset = terrain_altitude[-5:].mean() - xyz[-5:, 2].mean()
    xyz[:, 2] += np.linspace(start_offset, end_offset, len(xyz))

    time = np.array([datetime.fromtimestamp(fix.timestamp) for fix in raw.fixes])
    dt = np.array([delta.total_seconds() for delta in np.diff(time)])
    dt = np.pad(dt, (0, 1), mode="edge")
    dt[dt == 0] = 1

    displacement = np.diff(np.pad(xyz, ((0, 1), (0, 0)), mode="edge"), axis=0)
    velocity = displacement / dt[:, np.newaxis]
    ground_speed_ms = np.array([fix.gsp / 3.6 for fix in raw.fixes])

    sun_position = [get_position(t, x_lon, x_lat) for t, x_lon, x_lat in zip(time, lon, lat)]
    sun_azimuth = np.array([pos["azimuth"] for pos in sun_position])
    sun_altitude = np.array([pos["altitude"] for pos in sun_position])
    phi = -(sun_azimuth + np.pi / 2)
    theta = np.pi / 2 - sun_altitude
    sun_direction = np.column_stack((
        np.sin(theta) * np.cos(phi),
        np.sin(theta) * np.sin(phi),
        np.cos(theta),
    ))
    mean_sun_direction = sun_direction.mean(axis=0)
    mean_sun_direction /= np.linalg.norm(mean_sun_direction)

    wind_x, wind_y, airspeed, _sigma = circle_fit.hyperSVD(velocity[:, :2])
    launch_site = nearest_launch_site(xyz[0])

    return Flight(
        path=path,
        raw=raw,
        date=date.fromtimestamp(raw.date_timestamp),
        lat=lat,
        lon=lon,
        altitude=altitude,
        xyz=xyz,
        terrain_altitude=terrain_altitude,
        time=time,
        velocity=velocity,
        ground_speed_ms=ground_speed_ms,
        sun_azimuth=sun_azimuth,
        sun_direction=sun_direction,
        mean_sun_direction=mean_sun_direction,
        wind_vector_ms=np.array([wind_x, wind_y]),
        mean_airspeed_ms=float(airspeed),
        launch_site=launch_site,
    )


def nearest_launch_site(position: np.ndarray, max_distance_m: float = 250) -> LaunchSite | None:
    distances = np.array([np.linalg.norm(site.position - position) for site in LAUNCH_SITES])
    if len(distances) == 0 or distances.min() > max_distance_m:
        return None
    return LAUNCH_SITES[int(distances.argmin())]


class FlightCollection:
    def __init__(self, pattern: str = "LOGS/202*/*/*.IGC"):
        self.paths = [Path(path) for path in sorted(glob(str(PROJECT_ROOT / pattern)))]
        self.paths = [path for path in self.paths if not path.name.startswith("._")]

    def labels(self, valid_only: bool = False) -> list[dict[str, str]]:
        paths = self.valid_paths() if valid_only else self.paths
        return [{"label": path.relative_to(PROJECT_ROOT).as_posix(), "value": str(path)} for path in paths]

    def valid_paths(self) -> list[Path]:
        paths = []
        for path in self.paths:
            if (path.parent / "ignore").exists():
                continue
            raw = igc_lib.Flight.create_from_file(path)
            if raw.valid:
                paths.append(path)
        return paths

    def latest_valid_path(self) -> Path | None:
        for path in reversed(self.paths):
            if (path.parent / "ignore").exists():
                continue
            raw = igc_lib.Flight.create_from_file(path)
            if raw.valid:
                return path
        return None

    def load(self, path: str | Path) -> Flight:
        return load_flight(path)
