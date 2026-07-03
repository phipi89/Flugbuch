from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from time import perf_counter

from flask import Flask, Response, jsonify, request, send_from_directory

from .flight import FlightCollection, PROJECT_ROOT, load_flight
from .imagery import texture_for_region
from .landcover import landcover_overlay
from .terrain import adaptive_terrain_around_path, full_flight_circle, webgl_local_terrain_payload, webgl_terrain_payload, webgl_tile_payload


OVERVIEW_CACHE_DIR = PROJECT_ROOT / "cache" / "webgl_overviews"
OVERVIEW_CACHE_VERSION = "v4"
OVERVIEW_TERRAIN_GRID_SIDE = 240
OVERVIEW_PAYLOAD_GRID_SIDE = 220
MIN_RADIUS = 1500


@lru_cache(maxsize=32)
def test_flight_path(label: str | None = None) -> tuple[Path, str]:
    collection = FlightCollection()
    if label is None:
        path = collection.latest_valid_path()
    else:
        path = collection.path_for_label(label)
    if path is None:
        raise ValueError("Need at least one valid flight for the WebGL test page." if label is None else f"Unknown flight {label}")

    return path, path.relative_to(PROJECT_ROOT).as_posix()


@lru_cache(maxsize=32)
def test_flight(label: str | None = None):
    path, label = test_flight_path(label)
    print(f"[terrain] test flight {path}", flush=True)
    flight = load_flight(path)
    return flight, label


def overview_cache_path(path: Path) -> Path:
    stat = path.stat()
    key_data = "|".join(
        [
            OVERVIEW_CACHE_VERSION,
            path.resolve().as_posix(),
            str(stat.st_mtime_ns),
            str(stat.st_size),
            str(OVERVIEW_TERRAIN_GRID_SIDE),
            str(OVERVIEW_PAYLOAD_GRID_SIDE),
            str(MIN_RADIUS),
        ]
    )
    key = hashlib.sha256(key_data.encode()).hexdigest()[:24]
    return OVERVIEW_CACHE_DIR / f"{key}.jsonl"


@lru_cache(maxsize=32)
def flight_page_payload(label: str | None = None) -> tuple[str, str, str]:
    start = perf_counter()
    path, label = test_flight_path(label)
    cached_path = overview_cache_path(path)
    try:
        with cached_path.open("rt", encoding="utf-8") as f:
            cached_label = json.loads(f.readline())
            metadata_json = f.readline().rstrip("\n")
            overview_json = f.readline().rstrip("\n")
        if not metadata_json or not overview_json:
            raise ValueError("missing cached payload line")
        print(
            f"[terrain] overview cache HIT {cached_path.name} ({(perf_counter() - start) * 1000:.0f} ms)",
            flush=True,
        )
        return metadata_json, overview_json, cached_label
    except FileNotFoundError:
        pass
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[terrain] overview cache INVALID {cached_path.name}: {exc}", flush=True)

    print(f"[terrain] overview cache MISS {cached_path.name}", flush=True)
    flight_start = perf_counter()
    flight, label = test_flight(label)
    flight_ms = (perf_counter() - flight_start) * 1000
    center, radius = full_flight_circle(flight.xy)
    overview_start = perf_counter()
    overview_terrain = adaptive_terrain_around_path(flight.xy, max_grid_side=OVERVIEW_TERRAIN_GRID_SIDE)
    overview_ms = (perf_counter() - overview_start) * 1000
    payload_start = perf_counter()
    overview_payload = webgl_terrain_payload(overview_terrain, flight.xyz, flight.sun_azimuth, max_grid_side=OVERVIEW_PAYLOAD_GRID_SIDE)
    payload_ms = (perf_counter() - payload_start) * 1000
    overview_payload["fullCircle"] = {
        "center": center.astype(float).tolist(),
        "radius": radius,
    }
    overview_payload["minRadius"] = MIN_RADIUS
    overview_payload["maxRadius"] = radius
    overview_payload["focusIndex"] = 0
    overview_payload["resolution"] = overview_payload["terrain"]["dx"]

    cumulative_seconds = [(t - flight.time[0]).total_seconds() for t in flight.time]

    metadata = {
        "flightPath": flight.xyz.astype(float).tolist(),
        "timeSeconds": cumulative_seconds,
        "terrainAltitude": flight.terrain_altitude.astype(float).tolist(),
        "heightAboveGround": flight.height_above_ground.astype(float).tolist(),
        "groundSpeedMs": flight.ground_speed_ms.astype(float).tolist(),
        "verticalSpeedMs": flight.velocity[:, 2].astype(float).tolist(),
        "sun": {
            "startAzimuth": float(flight.sun_azimuth[0]),
            "endAzimuth": float(flight.sun_azimuth[-1]),
        },
        "sunDirections": flight.sun_direction.astype(float).tolist(),
        "meanSunDirection": flight.mean_sun_direction.astype(float).tolist(),
        "fullCircle": {
            "center": center.astype(float).tolist(),
            "radius": radius,
        },
        "minRadius": MIN_RADIUS,
        "maxRadius": radius,
    }

    json_start = perf_counter()
    metadata_json = json.dumps(metadata, separators=(",", ":"))
    overview_json = json.dumps(overview_payload, separators=(",", ":"))
    json_ms = (perf_counter() - json_start) * 1000

    cache_start = perf_counter()
    OVERVIEW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with cached_path.open("wt", encoding="utf-8") as f:
        f.write(json.dumps(label, separators=(",", ":")))
        f.write("\n")
        f.write(metadata_json)
        f.write("\n")
        f.write(overview_json)
        f.write("\n")
    cache_ms = (perf_counter() - cache_start) * 1000
    total_ms = (perf_counter() - start) * 1000
    print(
        f"[terrain] overview cache WRITE {cached_path.name} flight={flight_ms:.0f} ms overview={overview_ms:.0f} ms payload={payload_ms:.0f} ms json={json_ms:.0f} ms cache={cache_ms:.0f} ms total={total_ms:.0f} ms",
        flush=True,
    )
    return metadata_json, overview_json, label


@lru_cache(maxsize=1)
def flight_options() -> list[dict[str, str]]:
    collection = FlightCollection()
    return [
        {"label": path.relative_to(PROJECT_ROOT).as_posix(), "value": path.relative_to(PROJECT_ROOT).as_posix()}
        for path in collection.valid_paths()
    ]


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(PROJECT_ROOT / "assets", filename)

    @app.get("/terrain")
    def terrain() -> Response:
        start = perf_counter()
        flight_start = perf_counter()
        flight, _label = test_flight(request.args.get("flight"))
        flight_ms = (perf_counter() - flight_start) * 1000
        index = int(request.args.get("index", 0))
        radius = float(request.args.get("radius", 1500))
        payload_start = perf_counter()
        payload = webgl_local_terrain_payload(flight.xyz, flight.sun_azimuth, index, radius)
        payload_ms = (perf_counter() - payload_start) * 1000
        json_start = perf_counter()
        response = jsonify(payload)
        json_ms = (perf_counter() - json_start) * 1000
        grid = payload["terrain"]
        print(
            f"[terrain] local grid={grid['width']}x{grid['height']} radius={payload['circle']['radius']:.0f}m "
            f"resolution={payload['resolution']:.0f}m index={payload['focusIndex']} "
            f"flight={flight_ms:.0f} ms payload={payload_ms:.0f} ms json={json_ms:.0f} ms total={(perf_counter() - start) * 1000:.0f} ms",
            flush=True,
        )
        return response

    @app.get("/flights")
    def flights() -> Response:
        return jsonify({"flights": flight_options()})

    @app.get("/flight-payload")
    def flight_payload() -> Response:
        label = request.args.get("flight")
        try:
            metadata_json, overview_json, flight_label = flight_page_payload(label)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 404
        body = f'{{"label":{json.dumps(flight_label, separators=(",", ":"))},"metadata":{metadata_json},"overview":{overview_json}}}'
        return Response(body, mimetype="application/json")

    @app.get("/terrain-tile")
    def terrain_tile() -> Response:
        start = perf_counter()
        x0 = float(request.args["x0"])
        y0 = float(request.args["y0"])
        resolution = float(request.args.get("resolution", 5))
        size = int(request.args.get("size", 1000))
        payload_start = perf_counter()
        payload = webgl_tile_payload(x0, y0, resolution, tile_size_m=size)
        payload_ms = (perf_counter() - payload_start) * 1000
        json_start = perf_counter()
        response = jsonify(payload)
        json_ms = (perf_counter() - json_start) * 1000
        tile = payload["tile"]
        print(
            f"[terrain] tile endpoint x0={tile['x0']:.0f} y0={tile['y0']:.0f} resolution={tile['resolution']:.0f}m "
            f"payload={payload_ms:.0f} ms json={json_ms:.0f} ms total={(perf_counter() - start) * 1000:.0f} ms",
            flush=True,
        )
        return response

    @app.get("/terrain-texture")
    def terrain_texture() -> Response:
        x0 = float(request.args["x0"])
        y0 = float(request.args["y0"])
        resolution = float(request.args.get("resolution", 5))
        size = int(request.args.get("size", 1000))
        width = int(request.args.get("width", size))
        height = int(request.args.get("height", size))
        layer = request.args.get("layer", "swissimage")
        if layer not in ("swissimage", "pixelkarte"):
            return Response(status=400)
        start = perf_counter()
        data = texture_for_region(x0, y0, width, height, resolution, layer)
        ms = (perf_counter() - start) * 1000
        if data is None:
            print(f"[terrain] texture MISS  x0={x0:.0f} y0={y0:.0f} res={resolution:.0f} size={width}x{height} layer={layer} ({ms:.0f} ms)", flush=True)
            return Response(status=404)
        print(f"[terrain] texture HIT   x0={x0:.0f} y0={y0:.0f} res={resolution:.0f} size={width}x{height} layer={layer} ({len(data)} bytes, {ms:.0f} ms)", flush=True)
        return Response(data, mimetype="image/jpeg")

    @app.get("/terrain-overlay")
    def terrain_overlay() -> Response:
        x0 = float(request.args["x0"])
        y0 = float(request.args["y0"])
        width = int(request.args["width"])
        height = int(request.args["height"])
        resolution = float(request.args.get("resolution", 5))
        data = landcover_overlay(x0, y0, width, height, resolution)
        if data is None:
            return Response(status=404)
        return Response(data, mimetype="image/png")

    @app.get("/")
    def index() -> Response:
        start = perf_counter()
        payload_start = perf_counter()
        metadata_json, overview_json, flight_label = flight_page_payload()
        payload_ms = (perf_counter() - payload_start) * 1000
        html = f"""
        <!doctype html>
        <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Flugbuch WebGL Terrain Test</title>
                <style>
                    html, body {{ margin: 0; width: 100%; height: 100%; overflow: hidden; background: linear-gradient(180deg, #e8ecf0 0%, #ffffff 60%, #ffffff 100%); }}
                    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
                    #terrain-viewer {{ position: fixed; inset: 0; }}
                    #terrain-viewer canvas {{ display: block; width: 100%; height: 100%; }}
                    #terrain-status {{ position: fixed; top: 14px; left: 16px; z-index: 2; color: #e5e7eb; font-size: 13px; letter-spacing: .02em; }}
                    #flight-picker {{ position: fixed; top: 40px; left: 16px; z-index: 4; }}
                    #flight-picker-button {{ color: #e5e7eb; background: rgba(15,23,42,.72); border: 1px solid rgba(148,163,184,.45); border-radius: 8px; padding: 6px 10px; cursor: pointer; }}
                    #flight-picker-list {{ display: none; width: min(520px, calc(100vw - 32px)); max-height: 55vh; overflow: auto; margin-top: 6px; background: rgba(15,23,42,.9); border: 1px solid rgba(148,163,184,.35); border-radius: 10px; box-shadow: 0 14px 40px rgba(15,23,42,.35); }}
                    #flight-picker-list.open {{ display: block; }}
                    .flight-option {{ display: block; width: 100%; border: 0; border-bottom: 1px solid rgba(148,163,184,.18); padding: 8px 10px; color: #e5e7eb; background: transparent; text-align: left; font-size: 12px; cursor: pointer; }}
                    .flight-option:hover {{ background: rgba(148,163,184,.18); }}
                    #settings {{ position: fixed; top: 40px; right: 16px; z-index: 4; color: #e5e7eb; font-size: 12px; }}
                    #settings-button {{ color: #e5e7eb; background: rgba(15,23,42,.72); border: 1px solid rgba(148,163,184,.45); border-radius: 8px; padding: 6px 10px; cursor: pointer; }}
                    #settings-panel {{ display: none; min-width: 220px; margin-top: 6px; padding: 10px; background: rgba(15,23,42,.9); border: 1px solid rgba(148,163,184,.35); border-radius: 10px; box-shadow: 0 14px 40px rgba(15,23,42,.35); }}
                    #settings-panel.open {{ display: block; }}
                    #settings-panel label {{ display: block; margin-bottom: 10px; }}
                    #settings-panel select {{ width: 100%; margin-top: 4px; color: #e5e7eb; background: rgba(15,23,42,.96); border: 1px solid rgba(148,163,184,.45); border-radius: 6px; padding: 5px; }}
                    #flight-label {{ position: fixed; right: 16px; bottom: 14px; z-index: 2; color: #cbd5e1; font-size: 12px; }}
                    #flight-info {{ position: fixed; left: 16px; bottom: 48px; z-index: 3; color: #e5e7eb; background: rgba(15,23,42,.68); border: 1px solid rgba(148,163,184,.25); border-radius: 10px; padding: 9px 11px; font-size: 12px; line-height: 1.45; text-shadow: 0 1px 2px #020617; backdrop-filter: blur(4px); }}
                    #flight-info div {{ display: flex; justify-content: space-between; gap: 18px; min-width: 122px; }}
                    #flight-info span:first-child {{ color: #94a3b8; }}
                    #scrub {{ position: fixed; left: 16px; right: 16px; bottom: 18px; z-index: 3; accent-color: #f59e0b; }}
                    #help {{ position: fixed; top: 14px; right: 16px; z-index: 2; color: #94a3b8; font-size: 12px; }}
                    #scale {{ position: fixed; right: 16px; bottom: 48px; z-index: 3; color: #e5e7eb; font-size: 12px; text-align: center; text-shadow: 0 1px 2px #020617; }}
                    #scale-bar {{ height: 4px; min-width: 8px; margin-bottom: 4px; border: 1px solid rgba(255,255,255,.9); border-top: 0; background: rgba(245,158,11,.85); }}
                </style>
            </head>
            <body>
                <div id="terrain-status">Loading renderer...</div>
                <div id="flight-picker"><button id="flight-picker-button" type="button">Flights</button><div id="flight-picker-list"></div></div>
                <div id="settings">
                    <button id="settings-button" type="button">Settings</button>
                    <div id="settings-panel">
                        <label><input id="settings-landcover" type="checkbox" checked> Landcover overlay</label>
                        <label>Terrain style
                            <select id="settings-terrain-layer">
                                <option value="slope">Slope colors</option>
                                <option value="swissimage">swissimage</option>
                                <option value="pixelkarte">karte</option>
                            </select>
                        </label>
                        <label>View
                            <select id="settings-view-mode">
                                <option value="isometric">3D</option>
                                <option value="top">Top</option>
                            </select>
                        </label>
                    </div>
                </div>
                <div id="help">drag left/right to rotate · wheel to zoom · scrub along flight</div>
                <div id="terrain-viewer"></div>
                <div id="flight-info">
                    <div><span>ASL</span><strong id="info-asl">-</strong></div>
                    <div><span>AGL</span><strong id="info-agl">-</strong></div>
                    <div><span>Speed</span><strong id="info-speed">-</strong></div>
                    <div><span>Vario</span><strong id="info-vario">-</strong></div>
                </div>
                <div id="flight-label">{flight_label}</div>
                <div id="scale"><div id="scale-bar"></div><div>1 km</div></div>
                <input id="scrub" type="range" min="0" max="0" value="0" step="1">
                <script>window.TERRAIN_META = {metadata_json}; window.TERRAIN_OVERVIEW = {overview_json}; window.TERRAIN_FLIGHT_LABEL = {json.dumps(flight_label, separators=(",", ":"))}; window.TERRAIN_VIEW_MODE = "isometric";</script>
                <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
                <script src="/assets/terrain_viewer.js"></script>
            </body>
        </html>
        """
        print(
            f"[terrain] index payload={payload_ms:.0f} ms total={(perf_counter() - start) * 1000:.0f} ms",
            flush=True,
        )
        return Response(html, mimetype="text/html")

    return app


def main() -> None:
    app = create_app()
    app.run(debug=True)


if __name__ == "__main__":
    main()
