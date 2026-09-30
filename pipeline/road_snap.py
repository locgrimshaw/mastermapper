"""
road_snap.py
------------
Route short stop-to-stop hops along OS Open Roads, so a bus link drawn from a
timetable follows the street instead of cutting a straight line across the
block. Used by build_bus_network.py for every link the feed gives no route
shape for (most of London's, for one).

Method, per OS 100 km square (so the graph in memory stays small):
  1. Load the square's road links plus a 3 km margin from its neighbours.
  2. Snap each stop to the nearest road link (within SNAP_M) and take its
     position along that link.
  3. Dijkstra over the link graph from the first stop's link ends to the
     second's, bounded by a detour cutoff; stitch the partial first link, the
     path and the partial last link into one line.
  4. Reject a path longer than max(2.5 x straight, straight + 400 m) — a one-way
     system or a missing link would otherwise send the line on a tour — and
     leave that link straight.

Open Roads carries no turn or one-way restrictions, so a path can take a street
the bus cannot; over a single stop-to-stop hop the shortest road path is almost
always the bus's own.

Licence: OS Open Roads © Crown copyright (OGL v3).
"""

import heapq
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import pyogrio
import shapely
from pyproj import Transformer
from shapely.ops import substring

SNAP_M = 60           # stop to road link
MARGIN_M = 3000       # neighbour-square margin
TILE_M = 100_000

_to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
_to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)

# OS National Grid 100 km square letters, row by row from the south-west.
_GRID = ["SV SW SX SY SZ TV TW".split(), "SQ SR SS ST SU TQ TR".split(),
         "SL SM SN SO SP TL TM".split(), "SF SG SH SJ SK TF TG".split(),
         "SA SB SC SD SE TA TB".split(), "NV NW NX NY NZ OV OW".split(),
         "NQ NR NS NT NU OQ OR".split(), "NL NM NN NO NP OL OM".split(),
         "NF NG NH NJ NK OF OG".split(), "NA NB NC ND NE OA OB".split(),
         "HV HW HX HY HZ JV JW".split(), "HQ HR HS HT HU JQ JR".split(),
         "HL HM HN HO HP JL JM".split()]


def square_of(x, y):
    i, j = int(x // TILE_M), int(y // TILE_M)
    if 0 <= j < len(_GRID) and 0 <= i < 7:
        return _GRID[j][i]
    return None


def square_origin(sq):
    for j, row in enumerate(_GRID):
        if sq in row:
            return row.index(sq) * TILE_M, j * TILE_M
    return None


class RoadSnapper:
    def __init__(self, roads_zip):
        self.zip = Path(roads_zip)
        zf = zipfile.ZipFile(self.zip)
        self.paths = {}
        for n in zf.namelist():
            if n.endswith("_RoadLink.shp"):
                self.paths[n.rsplit("/", 1)[-1][:2]] = f"/vsizip/{self.zip}/{n}"

    def _load(self, sq):
        """Graph for one 100 km square plus margin."""
        ox, oy = square_origin(sq)
        bbox = (ox - MARGIN_M, oy - MARGIN_M, ox + TILE_M + MARGIN_M, oy + TILE_M + MARGIN_M)
        frames = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                s = square_of(ox + dx * TILE_M + 1, oy + dy * TILE_M + 1)
                if s not in self.paths:
                    continue
                df = pyogrio.read_dataframe(self.paths[s], columns=["startNode", "endNode"],
                                            bbox=None if (dx, dy) == (0, 0) else bbox)
                if len(df):
                    frames.append(df)
        if not frames:
            return None
        df = pd.concat(frames, ignore_index=True)
        df = df[~df["startNode"].isna() & ~df["endNode"].isna()]
        geoms = shapely.force_2d(df.geometry.values)
        lengths = shapely.length(geoms)
        ids = {}
        u = np.array([ids.setdefault(v, len(ids)) for v in df["startNode"]], dtype=np.int64)
        v = np.array([ids.setdefault(w, len(ids)) for w in df["endNode"]], dtype=np.int64)
        adj = [[] for _ in range(len(ids))]
        for k in range(len(geoms)):
            a, b, ln = int(u[k]), int(v[k]), float(lengths[k])
            adj[a].append((b, ln, k))
            adj[b].append((a, ln, k))
        return {"geoms": geoms, "len": lengths, "u": u, "v": v, "adj": adj,
                "tree": shapely.STRtree(geoms)}

    @staticmethod
    def _part(g, d0, d1):
        """Coordinates of link g from distance d0 to d1 (either order)."""
        a, b = sorted((d0, d1))
        seg = substring(g, a, b)
        c = list(seg.coords) if seg.geom_type == "LineString" else [seg.coords[0]]
        return c if d0 <= d1 else c[::-1]

    def _route(self, G, pa, pb):
        tree, geoms = G["tree"], G["geoms"]
        ia = tree.query_nearest(pa, max_distance=SNAP_M)
        ib = tree.query_nearest(pb, max_distance=SNAP_M)
        if len(ia) == 0 or len(ib) == 0:
            return None
        la, lb = int(ia[0]), int(ib[0])
        ga, gb = geoms[la], geoms[lb]
        ta, tb = ga.project(pa), gb.project(pb)
        straight = pa.distance(pb)
        limit = max(2.5 * straight, straight + 400)
        if la == lb:
            coords = self._part(ga, ta, tb)
            return coords if abs(tb - ta) <= limit else None
        Lb = float(G["len"][lb])
        # sources: the two ends of A's link, costed by the distance to reach them
        dist, prev = {}, {}
        heap = []
        for node, c, frm in ((int(G["u"][la]), ta, 0.0), (int(G["v"][la]), float(G["len"][la]) - ta, float(G["len"][la]))):
            if c < dist.get(node, 1e18):
                dist[node] = c
                prev[node] = ("start", frm)
                heapq.heappush(heap, (c, node))
        goals = {int(G["u"][lb]): tb, int(G["v"][lb]): Lb - tb}
        best, best_node = 1e18, None
        adj = G["adj"]
        while heap:
            c, n = heapq.heappop(heap)
            if c > dist.get(n, 1e18) or c > limit or c >= best:
                continue
            if n in goals and c + goals[n] < best:
                best, best_node = c + goals[n], n
            for m, ln, k in adj[n]:
                nc = c + ln
                if nc < dist.get(m, 1e18) and nc <= limit:
                    dist[m] = nc
                    prev[m] = (n, k)
                    heapq.heappush(heap, (nc, m))
        if best_node is None or best > limit:
            return None
        # walk back to the start link
        chain, n = [], best_node
        while True:
            p = prev[n]
            if p[0] == "start":
                start_end = p[1]
                break
            chain.append((p[1], p[0], n))       # (link, from node, to node)
            n = p[0]
        chain.reverse()
        out = self._part(ga, ta, start_end)
        for k, a, b in chain:
            c = list(geoms[k].coords)
            if int(G["u"][k]) != a:
                c = c[::-1]
            out.extend(c[1:])
        end_at = 0.0 if best_node == int(G["u"][lb]) else Lb
        out.extend(self._part(gb, end_at, tb)[1:])
        return out

    def snap(self, links, log=print):
        """links: {key: ((lonA, latA), (lonB, latB))} -> {key: [(lon, lat), ...]}"""
        keys = list(links)
        if not keys:
            return {}
        A = np.array([links[k][0] for k in keys])
        B = np.array([links[k][1] for k in keys])
        ax, ay = _to_bng.transform(A[:, 0], A[:, 1])
        bx, by = _to_bng.transform(B[:, 0], B[:, 1])
        by_sq = {}
        for i in range(len(keys)):
            sq = square_of((ax[i] + bx[i]) / 2, (ay[i] + by[i]) / 2)
            if sq in self.paths:
                by_sq.setdefault(sq, []).append(i)
        out, n_ok = {}, 0
        for sq, idx in sorted(by_sq.items()):
            G = self._load(sq)
            if G is None:
                continue
            ok = 0
            for i in idx:
                try:
                    c = self._route(G, shapely.Point(ax[i], ay[i]), shapely.Point(bx[i], by[i]))
                except Exception:
                    c = None
                if not c or len(c) < 2:
                    continue
                line = shapely.simplify(shapely.LineString(c), 1.5)
                xy = np.asarray(line.coords)
                lon, lat = _to_wgs.transform(xy[:, 0], xy[:, 1])
                out[keys[i]] = [(round(float(x), 5), round(float(y), 5)) for x, y in zip(lon, lat)]
                ok += 1
            n_ok += ok
            log(f"[snap] {sq}: {ok:,}/{len(idx):,} links routed on roads")
            del G
        log(f"[snap] {n_ok:,}/{len(keys):,} links follow the road network")
        return out
