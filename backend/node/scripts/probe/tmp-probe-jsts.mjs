import "jsts/org/locationtech/jts/monkey.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import ArrayList from "jsts/java/util/ArrayList.js";

const gf = new GeometryFactory();
const c = (x, y) => new Coordinate(x, y);
const ring = (pts) => gf.createLinearRing(pts.map(([x, y]) => c(x, y)));
const poly = (pts) => gf.createPolygon(ring(pts));

const sq = poly([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
console.log("area:", sq.getArea(), "valid:", sq.isValid());
console.log("centroid:", sq.getCentroid().getX(), sq.getCentroid().getY());
console.log("interiorPoint:", sq.getInteriorPoint().getX(), sq.getInteriorPoint().getY());
console.log("exterior coords:", sq.getExteriorRing().getCoordinates().map((p) => [p.x, p.y]));
console.log("numGeometries:", sq.getNumGeometries(), "geomType:", sq.getGeometryType());

// minimum rotated rectangle
const candidates = [
  ["jsts/org/locationtech/jts/algorithm/MinimumDiameter.js", "MinimumDiameter"],
  ["jsts/org/locationtech/jts/algorithm/MinimumRotatedRectangle.js", "MinimumRotatedRectangle"],
];
for (const [p, n] of candidates) {
  try {
    const mod = await import(p);
    const Cls = mod.default || mod[n];
    console.log(`OK import ${p} -> ${typeof Cls}`);
    const rect = poly([[0, 0], [10, 1], [9, 8], [-1, 7], [0, 0]]);
    const md = new Cls(rect);
    const mr = md.getMinimumRectangle ? md.getMinimumRectangle() : md.getMinimumRectangle?.();
    console.log("  minRect:", mr && mr.getExteriorRing().getCoordinates().map((q) => [q.x.toFixed(3), q.y.toFixed(3)]));
    console.log("  methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(md)));
  } catch (e) {
    console.log(`FAIL import ${p}: ${e.message}`);
  }
}

// polygonize
const segs = [
  gf.createLineString([c(0, 0), c(10, 0)]),
  gf.createLineString([c(10, 0), c(10, 10)]),
  gf.createLineString([c(10, 10), c(0, 10)]),
  gf.createLineString([c(0, 10), c(0, 0)]),
];
const list = new ArrayList();
list.addAll(segs);
const pz = new Polygonizer();
pz.add(list);
const got = pz.getPolygons();
console.log("getPolygons type:", got && got.constructor && got.constructor.name, "toArray?", typeof got.toArray);
const arr = got.toArray ? got.toArray() : Array.from(got);
console.log("polygonize count:", arr.length, "area0:", arr[0] && arr[0].getArea());

// unary union
const u = UnaryUnionOp.union(list);
console.log("union type:", u.getGeometryType(), "area:", u.getArea());
const u2 = UnaryUnionOp.union(new ArrayList().addAll ? (() => { const l = new ArrayList(); l.addAll([poly([[0,0],[4,0],[4,4],[0,4],[0,0]]), poly([[2,2],[6,2],[6,6],[2,6],[2,2]])]); return l; })() : null);
console.log("union of 2 polys:", u2.getGeometryType(), "area:", u2.getArea(), "numGeom:", u2.getNumGeometries());
console.log("convexHull:", u2.convexHull().getGeometryType(), u2.convexHull().getArea());
console.log("buffer(0):", u2.convexHull().buffer(0).getGeometryType());

// predicates
const a = poly([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
const b = poly([[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]);
console.log("a.contains(b interiorPt):", a.contains(b.getInteriorPoint()));
console.log("a.distance(outside pt):", a.distance(gf.createPoint(c(20, 20))));
console.log("symDifference area:", a.symDifference(b).getArea());
console.log("getGeometryN:", (() => { const mp = UnaryUnionOp.union((() => { const l = new ArrayList(); l.addAll([poly([[0,0],[1,0],[1,1],[0,1],[0,0]]), poly([[5,5],[6,5],[6,6],[5,6],[5,5]])]); return l; })()); console.log(" type:", mp.getGeometryType(), "n:", mp.getNumGeometries()); return mp.getGeometryN(1).getCentroid().getX(); })());
