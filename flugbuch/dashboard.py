from __future__ import annotations

import json
from functools import lru_cache
from time import perf_counter

from flask import Flask, Response, jsonify, request, send_from_directory

from .flight import FlightCollection, PROJECT_ROOT, load_flight
from .imagery import texture_for_tile
from .terrain import adaptive_terrain_around_path, full_flight_circle, webgl_local_terrain_payload, webgl_terrain_payload, webgl_tile_payload


@lru_cache(maxsize=1)
def test_flight():
    collection = FlightCollection()
    paths = collection.valid_paths()
    if len(paths) == 0:
        raise ValueError("Need at least one valid flight for the WebGL test page.")

    path = paths[-1]
    print(f"[terrain] test flight {path}", flush=True)
    flight = load_flight(path)
    return flight, path.relative_to(PROJECT_ROOT).as_posix()


@lru_cache(maxsize=1)
def flight_metadata() -> tuple[dict, dict, str]:
    flight, label = test_flight()
    center, radius = full_flight_circle(flight.xy)
    overview_terrain = adaptive_terrain_around_path(flight.xy, max_grid_side=240)
    overview_payload = webgl_terrain_payload(overview_terrain, flight.xyz, flight.sun_azimuth, max_grid_side=220)
    overview_payload["fullCircle"] = {
        "center": center.astype(float).tolist(),
        "radius": radius,
    }
    overview_payload["minRadius"] = 1500
    overview_payload["maxRadius"] = radius
    overview_payload["focusIndex"] = 0
    overview_payload["resolution"] = overview_payload["terrain"]["dx"]

    metadata = {
        "flightPath": flight.xyz.astype(float).tolist(),
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
        "minRadius": 1500,
        "maxRadius": radius,
    }
    return metadata, overview_payload, label


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(PROJECT_ROOT / "assets", filename)

    @app.get("/terrain")
    def terrain() -> Response:
        start = perf_counter()
        flight_start = perf_counter()
        flight, _label = test_flight()
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
        layer = request.args.get("layer", "swissimage")
        if layer not in ("swissimage", "pixelkarte"):
            return Response(status=400)
        start = perf_counter()
        data = texture_for_tile(x0, y0, size, resolution, layer)
        ms = (perf_counter() - start) * 1000
        if data is None:
            print(f"[terrain] texture MISS  x0={x0:.0f} y0={y0:.0f} res={resolution:.0f} size={size} layer={layer} ({ms:.0f} ms)", flush=True)
            return Response(status=404)
        print(f"[terrain] texture HIT   x0={x0:.0f} y0={y0:.0f} res={resolution:.0f} size={size} layer={layer} ({len(data)} bytes, {ms:.0f} ms)", flush=True)
        return Response(data, mimetype="image/jpeg")

    @app.get("/")
    def index() -> Response:
        metadata, overview_payload, flight_label = flight_metadata()
        metadata_json = json.dumps(metadata, separators=(",", ":"))
        overview_json = json.dumps(overview_payload, separators=(",", ":"))
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
                    #flight-label {{ position: fixed; right: 16px; bottom: 14px; z-index: 2; color: #cbd5e1; font-size: 12px; }}
                    #scrub {{ position: fixed; left: 16px; right: 16px; bottom: 18px; z-index: 3; accent-color: #f59e0b; }}
                    #help {{ position: fixed; top: 14px; right: 16px; z-index: 2; color: #94a3b8; font-size: 12px; }}
                    #scale {{ position: fixed; right: 16px; bottom: 48px; z-index: 3; color: #e5e7eb; font-size: 12px; text-align: center; text-shadow: 0 1px 2px #020617; }}
                    #scale-bar {{ height: 4px; min-width: 8px; margin-bottom: 4px; border: 1px solid rgba(255,255,255,.9); border-top: 0; background: rgba(245,158,11,.85); }}
                </style>
            </head>
            <body>
                <div id="terrain-status">Loading renderer...</div>
                <div id="help">drag left/right to rotate · wheel to zoom · scrub along flight</div>
                <div id="terrain-viewer"></div>
                <div id="flight-label">{flight_label}</div>
                <div id="scale"><div id="scale-bar"></div><div>1 km</div></div>
                <input id="scrub" type="range" min="0" max="0" value="0" step="1">
                <script>window.TERRAIN_META = {metadata_json}; window.TERRAIN_OVERVIEW = {overview_json}; window.TERRAIN_VIEW_MODE = "isometric";</script>
                <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
                <script src="/assets/terrain_viewer.js"></script>
            </body>
        </html>
        """
        return Response(html, mimetype="text/html")

    return app


def main() -> None:
    app = create_app()
    app.run(debug=True)


if __name__ == "__main__":
    main()
