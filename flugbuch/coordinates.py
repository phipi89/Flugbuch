"""Coordinate transforms used by the flight log."""


def wgs84_to_lv95(lat: float, lon: float, height: float) -> tuple[float, float, float]:
    """Convert WGS84 coordinates to Swiss LV95 coordinates.

    The formula is the official approximation via LV03, with the LV95 offset
    applied at the end.
    """

    lat_seconds = lat * 3600
    lon_seconds = lon * 3600

    lat_aux = (lat_seconds - 169028.66) / 10000
    lon_aux = (lon_seconds - 26782.5) / 10000

    x_lv03 = (
        200147.07
        + 308807.95 * lat_aux
        + 3745.25 * lon_aux**2
        + 76.63 * lat_aux**2
        - 194.56 * lon_aux**2 * lat_aux
        + 119.79 * lat_aux**3
    )

    y_lv03 = (
        600072.37
        + 211455.93 * lon_aux
        - 10938.51 * lon_aux * lat_aux
        - 0.36 * lon_aux * lat_aux**2
        - 44.54 * lon_aux**3
    )

    h_lv03 = height - 49.55 + 2.73 * lon_aux + 6.94 * lat_aux
    return y_lv03 + 2_000_000, x_lv03 + 1_000_000, h_lv03
