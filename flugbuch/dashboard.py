from __future__ import annotations

from functools import lru_cache

from dash import Dash, Input, Output, dcc, html
import plotly.graph_objects as go

from .flight import FlightCollection, load_flight
from .plots import altitude_figure, terrain_figure, wind_figure
from .terrain import adaptive_terrain_around_path


collection = FlightCollection()


@lru_cache(maxsize=8)
def cached_flight(path: str):
    return load_flight(path)


@lru_cache(maxsize=4)
def cached_terrain(path: str):
    flight = cached_flight(path)
    return adaptive_terrain_around_path(flight.xy)


def empty_figure(message: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=message, x=0.5, y=0.5, xref="paper", yref="paper", showarrow=False)
    fig.update_layout(height=360, margin=dict(l=20, r=20, t=20, b=20))
    return fig


def create_app() -> Dash:
    app = Dash(__name__)
    options = collection.labels(valid_only=True)
    default_value = options[-1]["value"] if options else None

    app.layout = html.Div(
        [
            html.Div(
                [
                    html.H1("Flugbuch"),
                    html.P("Paragliding flights with terrain shaded by the actual sun position."),
                    dcc.Dropdown(id="flight", options=options, value=default_value, clearable=False),
                    html.Div(id="summary", className="summary"),
                ],
                className="sidebar",
            ),
            html.Div(
                [
                    dcc.Loading(dcc.Graph(id="terrain", config={"displayModeBar": False})),
                    html.Div(
                        [
                            dcc.Loading(dcc.Graph(id="wind", config={"displayModeBar": False}, className="panel")),
                            dcc.Loading(dcc.Graph(id="altitude", config={"displayModeBar": False}, className="panel")),
                        ],
                        className="lower-grid",
                    ),
                ],
                className="content",
            ),
        ],
        className="app",
    )

    app.index_string = """
    <!DOCTYPE html>
    <html>
        <head>
            {%metas%}
            <title>Flugbuch</title>
            {%favicon%}
            {%css%}
            <style>
                body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f3f4f6; color: #111827; }
                .app { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
                .sidebar { padding: 24px; background: #111827; color: #e5e7eb; }
                .sidebar h1 { margin: 0 0 8px; }
                .sidebar p { color: #9ca3af; line-height: 1.45; }
                .summary { margin-top: 20px; line-height: 1.7; }
                .content { padding: 16px; }
                .lower-grid { display: grid; grid-template-columns: 380px 1fr; gap: 16px; }
                .panel { background: white; border-radius: 12px; }
                @media (max-width: 1000px) { .app { grid-template-columns: 1fr; } .lower-grid { grid-template-columns: 1fr; } }
            </style>
        </head>
        <body>
            {%app_entry%}
            <footer>{%config%}{%scripts%}{%renderer%}</footer>
        </body>
    </html>
    """

    @app.callback(
        Output("summary", "children"),
        Output("terrain", "figure"),
        Output("wind", "figure"),
        Output("altitude", "figure"),
        Input("flight", "value"),
    )
    def update(path: str):
        try:
            flight = cached_flight(path)
            terrain = cached_terrain(path)
        except Exception as exc:
            message = f"Could not load flight: {exc}"
            summary = html.Div(message)
            figure = empty_figure(message)
            return summary, figure, figure, figure

        launch = flight.launch_site.name if flight.launch_site else "unknown"
        summary = html.Div(
            [
                html.Div(f"Flight: {flight.path.name}"),
                html.Div(f"Date: {flight.date.isoformat()}"),
                html.Div(f"Launch: {launch}"),
                html.Div(f"Duration: {flight.duration_seconds / 60:.0f} min"),
                html.Div(f"Wind: {flight.wind_speed_kmh:.0f} km/h"),
                html.Div(f"Max altitude: {flight.z.max():.0f} m"),
                html.Div(f"Max height over terrain: {flight.height_above_ground.max():.0f} m"),
            ]
        )
        return summary, terrain_figure(flight, terrain), wind_figure(flight), altitude_figure(flight)

    return app


def main() -> None:
    app = create_app()
    app.run(debug=True)


if __name__ == "__main__":
    main()
