import sys
sys.path.insert(0, 'IGClib')
import igc_lib

from pathlib import Path
from glob import glob
import numpy as np
import scipy.ndimage
from scipy.interpolate import RectBivariateSpline
import random
from tqdm.auto import tqdm

import joblib
from urllib.request import urlopen
import PIL

from pathvalidate import sanitize_filename

import circle_fit

from suncalc import get_position
from datetime import datetime, timedelta, date
import locale

locale.setlocale(locale.LC_ALL, 'de_DE.UTF-8')


swissalti3d_tile_urls = np.loadtxt('src/swisstopo/swissalti3d.csv', dtype='str')

def swissalti3d_tile_url(x, y):
    for path in swissalti3d_tile_urls:
        if f'{x}-{y}' in path:
            return path
    raise ValueError('Coordinates are outside swissAlti3d range.')


def swissalti3d_spline_tile(x_start, y_start):
    url = swissalti3d_tile_url(x_start, y_start)
    cached_path = Path('cache') / 'alti3d' / sanitize_filename(url)
    try:
        spline = joblib.load(cached_path)
        
    except FileNotFoundError:
        data = np.array(PIL.Image.open(urlopen(url))).T
    
        x = np.arange(x_start * 1000, x_start * 1000 + 1000, 2)
        y = np.arange(y_start * 1000, y_start * 1000 + 1000, 2)
    
        spline = RectBivariateSpline(x, y, np.fliplr(data))
        joblib.dump(spline, cached_path, compress=True)
        
    return spline


def swissalti3d_tile(x_start, y_start, resolution=500):
    spline = swissalti3d_spline_tile(x_start, y_start)
    X, Y = np.meshgrid(np.linspace(0, 1000, resolution + 1)[:-1] + (1000 * x_start),
                       np.linspace(0, 1000, resolution + 1)[:-1] + (1000 * y_start))
    
    return spline.ev(X, Y)


class LaunchSite:
    def __init__(self, name, coords):
        self.name = name
        self.position = np.asarray(coords)
        
    def distance(self, coords):
        return np.linalg.norm(self.position - coords)
    
    def is_close(self, coords):
        return self.distance(coords) < 100
    
    def __repr__(self):
        return self.name
    
    
class LaunchSites:
    def __init__(self):
        self.sites = [LaunchSite('Gurli', [2_588_081, 1_173_604, 1408.6]),
                      LaunchSite('Schwarzsee, Riggisalp', [2_588_910, 1_167_592, 1470.5]),
                      LaunchSite('Hohmattli', [2_590_782, 1_168_724, 1782.6]),
                      LaunchSite('Charmey, Vounetz', [2_582_200, 1_163_814, 1610.4]),
                      LaunchSite('Möntschele', [2_605_439, 1_173_806, 1401.9]),
                      LaunchSite('Grandvillard, Les Merlas', [2_575_600, 1_154_901, 1742.6])]
        
    def assign(self, coords, allowed_distance=250):
        distances = [site.distance(coords) for site in self]
        if np.min(distances) > allowed_distance:
            print(f"Closest launch site ({self[np.argmin(distances)]}) is {np.min(distances)/1000:.0f} km away.")
            return None
        else:
            return self[np.argmin(distances)]
        
    def __iter__(self):
        self.i = 0
        return self
    
    def __next__(self):
        if self.i < len(self.sites):
            self.i += 1
            return self.sites[self.i-1]
        else:
            raise StopIteration
            
    def __getitem__(self, index):
        return self.sites[index]


class Fix:
    def __init__(self, flight, i):
        self.lat = flight.lat[i]
        self.lng = flight.lng[i]
        self.alt = flight.alt[i]
        
        self.x = flight.x[i]
        self.y = flight.y[i]
        self.z = flight.z[i]
        
        self.t = flight.t[i]
        self.v_abs = flight.v_abs[i]
        

class Flight:
    def __init__(self, path):
        self.path = path
        self.raw = igc_lib.Flight.create_from_file(self.path)
        
        ignore = (Path(self.path).parent / 'ignore').exists()
        self.valid = self.raw.valid and not ignore
        if not self.valid:
            return None
        
        self.date = date.fromtimestamp(self.raw.date_timestamp)
        
        self.lat = np.array([fix.lat for fix in self.raw.fixes])
        self.lng = np.array([fix.lon for fix in self.raw.fixes])
        self.alt = np.array([fix.gnss_alt for fix in self.raw.fixes])
        
        lv03 = [self.wsg84_to_lv03(fix.lat, fix.lon, fix.gnss_alt)
                for fix in self.raw.fixes]
        lv03 = np.array(lv03) + [2_000_000, 1_000_000, 0]

        self.xyz = scipy.ndimage.gaussian_filter1d(lv03, sigma=0.5, axis=0)
        
        self.x, self.y, self.z = np.transpose(self.xyz)
        self.xy = np.transpose([self.x, self.y])

        ## COMPUTE GROUND LEVEL
        kilometers = [tuple(c) for c in (self.xy // 1000).astype(int)]
        tile_coords = set(kilometers)
        tiles = {coords: swissalti3d_spline_tile(*coords) for coords in tqdm(tile_coords)}
        ground_level = []
        for xy in self.xy:
            km = tuple((xy // 1000).astype(int))
            x, y = xy
            ground_level.append(tiles[km](x, y)[0, 0])

        self.ground_level = np.array(ground_level)

        start_offset = self.ground_level[:5].mean() - self.z[:5].mean()
        end_offset = self.ground_level[-5:].mean() - self.z[-5:].mean()
        alt_offset = np.linspace(start_offset, end_offset, len(self.z))

        # linear squeeze altitude so that takeoff and landing heights are correct
        self.z += alt_offset
        self.xyz[:, 2] = self.z

        self.t = np.array([datetime.fromtimestamp(fix.timestamp) for fix in self.raw.fixes])
        time_deltas = np.array([d.total_seconds() for d in np.diff(self.t)])
        self.time_deltas = np.pad(time_deltas, (0, 1), mode='edge')
        self.str_time = self.t[0].strftime('%Y-%m-%dT%H:%M')
        
        # Direction is a vector pointing in the flight direction
        # with length equal to its speed in m/s
        d = np.diff(np.pad(self.xyz, ((0, 1), (0, 0)), mode='edge'), axis=0)
        self.direction = np.transpose(d.T / self.time_deltas)
    
        self.v_abs = np.array([fix.gsp / 3.6 for fix in self.raw.fixes])
        
        sun_position = [list(get_position(fix.t, fix.lng, fix.lat).values()) for fix in self]
        self.sun_azimuth, self.sun_altitude = np.transpose(sun_position)

        phi = -(self.sun_azimuth + np.pi / 2)
        theta = np.pi / 2 - self.sun_altitude
        self.sun_direction = np.transpose([np.sin(theta) * np.cos(phi),
                                           np.sin(theta) * np.sin(phi),
                                           np.cos(theta)])

        self.mean_sun_direction = np.mean(self.sun_direction, axis=0)
        self.mean_sun_direction /= np.linalg.norm(self.mean_sun_direction)
        
        self.duration = self.t[-1] - self.t[0]

        x, y, r, sigma = circle_fit.hyperSVD(self.direction[..., :2])
        self.wind_direction = np.array([x, y])
        self.mean_airspeed = r
        self.mean_groundspeed = np.mean(self.v_abs)

        self.launch_site = launch_sites.assign(self.xyz[0])
        
        
    def __iter__(self):
        """Iterates over fixes.
        """

        self.i = 0
        return self

    def __next__(self):
        """Returns the next GPS fix, which are
        usually spaced 1 second apart.
        """

        if self.i < len(self.lat):
            fix = Fix(self, self.i)
            self.i += 1
            return fix
        else:
            raise StopIteration


    def wsg84_to_lv03(self, x, y, h):
        """Convert regular GPS coordinates to the Swiss
        Landesvermessung03 system.
        """

        lat = x * 3600
        lng = y * 3600

        lat_aux = (lat - 169028.66) / 10000
        lng_aux = (lng - 26782.5) / 10000
        x = ((200147.07 + (308807.95 * lat_aux) + \
            + (3745.25 * pow(lng_aux, 2)) + \
            + (76.63 * pow(lat_aux,2))) + \
            - (194.56 * pow(lng_aux, 2) * lat_aux)) + \
            + (119.79 * pow(lat_aux, 3))

        y = (600072.37 + (211455.93 * lng_aux)) + \
            - (10938.51 * lng_aux * lat_aux) + \
            - (0.36 * lng_aux * pow(lat_aux, 2)) + \
            - (44.54 * pow(lng_aux, 3))

        h = (h - 49.55) + (2.73 * lng_aux) + (6.94 * lat_aux)

        return y, x, h
    
    def __repr__(self) -> str:
        return (f'<\n'
        + f'   Flug vom {self.date.strftime("%d. %B %Y")}\n'
        + f'   Startplatz: {self.launch_site}\n'
        + f'   Dauer: {self.duration.total_seconds() // 3600:.0f}h{(self.duration.total_seconds() % 3600)/60:.0f}\n'
        + '>')
    


class Flights:
    list: list = []
    i: int = 0

    def __init__(self):
        paths = sorted(glob('LOGS/202*/*/*.IGC'))

        for path in tqdm(paths):
            flight = Flight(path)
            if flight.valid:
                self.list.append(flight)

    def random(self):
        return random.choice(self.list)
    
    def __iter__(self):
        self.i = 0
        return self
    
    def __next__(self):
        if self.i < len(self.list):
            self.i += 1
            return self.list[self.i-1]
        else:
            raise StopIteration
            
    def __getitem__(self, index):
        return self.list[index]



launch_sites = LaunchSites()