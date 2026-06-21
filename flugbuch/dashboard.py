from __future__ import annotations

import json

from flask import Flask, Response, send_from_directory

from .flight import FlightCollection, PROJECT_ROOT, load_flight
from .terrain import adaptive_terrain_around_path, webgl_terrain_payload


def terrain_payload_for_test_flight() -> tuple[dict, str]:
    collection = FlightCollection()
    paths = collection.valid_paths()
    if len(paths) == 0:
        raise ValueError("Need at least one valid flight for the WebGL test page.")

    path = paths[-1]
    print(f"[terrain] test flight {path}", flush=True)
    flight = load_flight(path)
    terrain = adaptive_terrain_around_path(flight.xy, max_grid_side=420)
    payload = webgl_terrain_payload(terrain, flight.xyz, flight.sun_azimuth, max_grid_side=260)
    grid = payload["terrain"]
    print(
        f"[terrain] payload ready grid={grid['width']}x{grid['height']} path={len(payload['flightPath'])}",
        flush=True,
    )
    return payload, path.relative_to(PROJECT_ROOT).as_posix()


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(PROJECT_ROOT / "assets", filename)

    @app.get("/")
    def index() -> Response:
        payload, flight_label = terrain_payload_for_test_flight()
        payload_json = json.dumps(payload, separators=(",", ":"))
        html = f"""
        <!doctype html>
        <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Flugbuch WebGL Terrain Test</title>
                <style>
                    html, body {{ margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0b1020; }}
                    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
                    #terrain-viewer {{ position: fixed; inset: 0; }}
                    #terrain-viewer canvas {{ display: block; width: 100%; height: 100%; }}
                    #terrain-status {{ position: fixed; top: 14px; left: 16px; z-index: 2; color: #e5e7eb; font-size: 13px; letter-spacing: .02em; }}
                    #flight-label {{ position: fixed; right: 16px; bottom: 14px; z-index: 2; color: #cbd5e1; font-size: 12px; }}
                </style>
            </head>
            <body>
                <div id="terrain-status">Loading renderer...</div>
                <div id="terrain-viewer"></div>
                <div id="flight-label">{flight_label}</div>
                <script>window.TERRAIN_PAYLOAD = {payload_json}; window.TERRAIN_VIEW_MODE = "isometric";</script>
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
