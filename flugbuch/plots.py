from __future__ import annotations

import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import scipy.ndimage

from .flight import Flight
from .terrain import TerrainGrid, sun_exposure, terrain_around_path


DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def compass_direction(degrees: float) -> str:
    return DIRECTIONS[int((degrees / 22.5) + 0.5) % 16]


def terrain_figure(flight: Flight, terrain: TerrainGrid | None = None) -> go.Figure:
    if terrain is None:
        terrain = terrain_around_path(flight.xy)

    exposure = sun_exposure(terrain.normals, flight.mean_sun_direction)
    elevation = (terrain.z - np.nanmin(terrain.z)) / (np.nanmax(terrain.z) - np.nanmin(terrain.z))
    shaded_relief = np.clip(0.68 * exposure + 0.32 * elevation, 0, 1)

    center = np.array([
        (float(flight.x.min()) + float(flight.x.max())) / 2,
        (float(flight.y.min()) + float(flight.y.max())) / 2,
    ])
    radius = float(np.linalg.norm(flight.xy - center, axis=1).max() + 300)
    outer_radius = radius * 1.14

    sun_angles = np.unwrap(-(flight.sun_azimuth + np.pi / 2))
    sun_arc_angles = np.linspace(float(sun_angles[0]), float(sun_angles[-1]), 80)
    sun_arc_radius = radius * 1.065
    sun_arc_x = center[0] + sun_arc_radius * np.cos(sun_arc_angles)
    sun_arc_y = center[1] + sun_arc_radius * np.sin(sun_arc_angles)

    fig = go.Figure()
    fig.add_trace(
        go.Heatmap(
            x=terrain.x,
            y=terrain.y,
            z=shaded_relief,
            colorscale=[
                [0.0, "#132015"],
                [0.25, "#31543a"],
                [0.50, "#72805b"],
                [0.75, "#b9ad81"],
                [1.0, "#fff0bf"],
            ],
            zmin=0,
            zmax=1.0,
            showscale=False,
            hovertemplate="x=%{x:.0f}<br>y=%{y:.0f}<br>shade=%{z:.2f}<extra></extra>",
        )
    )
    fig.add_trace(
        go.Contour(
            x=terrain.x,
            y=terrain.y,
            z=terrain.z,
            contours=dict(start=0, end=5000, size=100, coloring="none"),
            line=dict(color="rgba(255,255,255,0.22)", width=0.5),
            showscale=False,
            hoverinfo="skip",
        )
    )
    fig.add_shape(
        type="circle",
        xref="x",
        yref="y",
        x0=center[0] - radius,
        y0=center[1] - radius,
        x1=center[0] + radius,
        y1=center[1] + radius,
        line=dict(color="rgba(255,255,255,0.72)", width=1.5),
    )
    fig.add_trace(
        go.Scatter(
            x=sun_arc_x,
            y=sun_arc_y,
            mode="lines",
            line=dict(color="#f59e0b", width=5),
            name="sun travel",
            hoverinfo="skip",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[sun_arc_x[0], sun_arc_x[-1]],
            y=[sun_arc_y[0], sun_arc_y[-1]],
            mode="markers",
            marker=dict(color=["#fde68a", "#f97316"], size=[8, 11], line=dict(color="#0b1020", width=1)),
            name="sun start / landing",
            hovertemplate="%{text}<extra></extra>",
            text=["sun at takeoff", "sun at landing"],
        )
    )
    fig.add_trace(
        go.Scatter(
            x=flight.x,
            y=flight.y,
            mode="lines",
            line=dict(color="white", width=3),
            name="flight",
            hovertemplate="%{x:.0f}, %{y:.0f}<extra>flight</extra>",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[flight.x[0]],
            y=[flight.y[0]],
            mode="markers",
            marker=dict(color="#22c55e", size=10, line=dict(color="white", width=1)),
            name="takeoff",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[flight.x[-1]],
            y=[flight.y[-1]],
            mode="markers",
            marker=dict(color="#ef4444", size=10, line=dict(color="white", width=1)),
            name="landing",
        )
    )

    fig.update_yaxes(scaleanchor="x", scaleratio=1, range=[center[1] - outer_radius, center[1] + outer_radius], visible=False)
    fig.update_xaxes(range=[center[0] - outer_radius, center[0] + outer_radius], visible=False)
    fig.update_layout(
        title="Terrain shaded by actual sun exposure",
        height=720,
        margin=dict(l=10, r=10, t=50, b=10),
        plot_bgcolor="#0b1020",
        paper_bgcolor="#0b1020",
        font=dict(color="#e5e7eb"),
        legend=dict(orientation="h", yanchor="bottom", y=0.01, xanchor="left", x=0.01),
    )
    return fig


def wind_figure(flight: Flight) -> go.Figure:
    velocity_kmh = flight.velocity[:, :2] * 3.6
    wind_kmh = flight.wind_vector_ms * 3.6
    limit = max(20, float(np.nanpercentile(np.linalg.norm(velocity_kmh, axis=1), 98)) * 1.1)
    direction = compass_direction(flight.wind_from_degrees)

    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=velocity_kmh[:, 0],
            y=velocity_kmh[:, 1],
            mode="markers",
            marker=dict(size=4, color="rgba(56,189,248,0.25)"),
            name="ground velocity",
            hoverinfo="skip",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[0, wind_kmh[0]],
            y=[0, wind_kmh[1]],
            mode="lines+markers",
            line=dict(color="#ef4444", width=4),
            marker=dict(size=[1, 10], color="#ef4444"),
            name=f"wind {flight.wind_speed_kmh:.0f} km/h {direction}",
        )
    )
    fig.add_shape(type="circle", x0=-limit, y0=-limit, x1=limit, y1=limit, line=dict(color="rgba(255,255,255,0.2)"))
    fig.update_yaxes(scaleanchor="x", scaleratio=1, range=[-limit, limit], title="north/south km/h")
    fig.update_xaxes(range=[-limit, limit], title="east/west km/h")
    fig.update_layout(
        title=f"Wind estimate: {flight.wind_speed_kmh:.0f} km/h from {direction}",
        height=360,
        margin=dict(l=40, r=10, t=50, b=40),
        showlegend=False,
    )
    return fig


def altitude_figure(flight: Flight) -> go.Figure:
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, row_heights=[0.62, 0.38], vertical_spacing=0.05)

    terrain = scipy.ndimage.gaussian_filter1d(flight.terrain_altitude, 3)
    agl = flight.z - terrain
    thermal_mask = np.zeros(len(flight.z), dtype=bool)
    for thermal in getattr(flight.raw, "thermals", []):
        thermal_mask[thermal.enter_fix.index : thermal.exit_fix.index + 1] = True

    fig.add_trace(go.Scatter(x=flight.time, y=flight.z, mode="lines", line=dict(color="#2563eb"), name="altitude"), row=1, col=1)
    fig.add_trace(go.Scatter(x=flight.time, y=terrain, mode="lines", line=dict(color="#6b7280"), name="terrain"), row=1, col=1)
    fig.add_trace(
        go.Scatter(x=flight.time, y=np.where(thermal_mask, agl, np.nan), mode="lines", line=dict(color="#dc2626", width=2), name="height over terrain (thermal)"),
        row=1,
        col=1,
    )
    fig.add_trace(
        go.Scatter(x=flight.time, y=np.where(~thermal_mask, agl, np.nan), mode="lines", line=dict(color="#111827", width=1), name="height over terrain"),
        row=1,
        col=1,
    )

    smoothed_z = scipy.ndimage.gaussian_filter1d(flight.z, 3)
    seconds = np.array([(t - flight.time[0]).total_seconds() for t in flight.time])
    climb = np.diff(smoothed_z) / np.diff(seconds)
    climb_time = flight.time[1:]
    fig.add_trace(go.Scatter(x=climb_time, y=climb, mode="lines", line=dict(color="#111827", width=1), name="climb/sink"), row=2, col=1)
    fig.add_trace(
        go.Scatter(x=climb_time, y=np.where(climb > 0, climb, 0), fill="tozeroy", mode="none", fillcolor="rgba(37,99,235,0.18)", name="climb"),
        row=2,
        col=1,
    )
    fig.add_trace(
        go.Scatter(x=climb_time, y=np.where(climb < -1, climb, 0), fill="tozeroy", mode="none", fillcolor="rgba(220,38,38,0.16)", name="sink > 1 m/s"),
        row=2,
        col=1,
    )

    fig.update_yaxes(title="meters", row=1, col=1)
    fig.update_yaxes(title="m/s", range=[-6, 6], row=2, col=1)
    fig.update_layout(title="Height, terrain, and climb/sink", height=520, margin=dict(l=50, r=20, t=50, b=30))
    return fig
