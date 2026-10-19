import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { BACKEND } from "@/lib/api";

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

export default function CanvasImageOverlay({ overlay, transform, boundary, opacity = 0.85 }) {
  const map = useMap();

  useEffect(() => {
    if (!overlay?.base_url || !overlay?.bounds) return undefined;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = `position:absolute;left:0;top:0;z-index:450;opacity:${opacity};pointer-events:none`;
    map.getContainer().appendChild(canvas);
    const context = canvas.getContext("2d");
    const image = new Image();
    image.src = `${BACKEND}${overlay.base_url}`;
    const bounds = overlay.bounds;
    const options = {
      rotation: (transform?.rotation_deg || 0) * Math.PI / 180,
      scaleX: transform?.scale_x ?? 1,
      scaleY: transform?.scale_y ?? 1,
      translateX: transform?.translation_x_m || 0,
      translateY: transform?.translation_y_m || 0,
    };

    const redraw = () => {
      if (!context || !image.complete || !image.naturalWidth) return;
      const size = map.getSize();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(size.x * ratio);
      canvas.height = Math.round(size.y * ratio);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      context.clearRect(0, 0, size.x * ratio, size.y * ratio);
      if (boundary?.coordinates) {
        const polygons = boundary.type === "Polygon"
          ? [boundary.coordinates]
          : boundary.type === "MultiPolygon"
            ? boundary.coordinates
            : [];
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.beginPath();
        for (const rings of polygons) {
          for (const ring of rings) {
            ring.forEach(([lng, lat], index) => {
              const point = map.latLngToContainerPoint([lat, lng]);
              if (index === 0) context.moveTo(point.x, point.y);
              else context.lineTo(point.x, point.y);
            });
            context.closePath();
          }
        }
        context.clip("evenodd");
      }

      const zoom = map.getZoom();
      const northWest = map.project([bounds[1][0], bounds[0][1]], zoom);
      const northEast = map.project([bounds[1][0], bounds[1][1]], zoom);
      const southEast = map.project([bounds[0][0], bounds[1][1]], zoom);
      const southWest = map.project([bounds[0][0], bounds[0][1]], zoom);
      const center = L.point(
        (northWest.x + southEast.x) / 2,
        (northWest.y + southEast.y) / 2,
      );
      const pixelsPerMeter = 256 * 2 ** zoom / EARTH_CIRCUMFERENCE;
      const cosine = Math.cos(options.rotation);
      const sine = Math.sin(options.rotation);
      const transformPoint = (point) => {
        const x = (point.x - center.x) * options.scaleX;
        const y = (point.y - center.y) * options.scaleY;
        return L.point(
          center.x + x * cosine - y * sine + options.translateX * pixelsPerMeter,
          center.y + x * sine + y * cosine - options.translateY * pixelsPerMeter,
        );
      };
      const toContainer = (point) => map.latLngToContainerPoint(map.unproject(transformPoint(point), zoom));
      const nw = toContainer(northWest);
      const ne = toContainer(northEast);
      const sw = toContainer(southWest);
      const a = (ne.x - nw.x) / image.naturalWidth;
      const b = (ne.y - nw.y) / image.naturalWidth;
      const c = (sw.x - nw.x) / image.naturalHeight;
      const d = (sw.y - nw.y) / image.naturalHeight;
      context.setTransform(
        ratio * a, ratio * b, ratio * c, ratio * d, ratio * nw.x, ratio * nw.y,
      );
      context.drawImage(image, 0, 0);
    };

    image.addEventListener("load", redraw);
    map.on("move zoom resize zoomend", redraw);
    redraw();
    return () => {
      image.removeEventListener("load", redraw);
      map.off("move zoom resize zoomend", redraw);
      canvas.remove();
    };
  }, [
    map,
    overlay?.base_url,
    overlay?.bounds,
    transform?.rotation_deg,
    transform?.scale_x,
    transform?.scale_y,
    transform?.translation_x_m,
    transform?.translation_y_m,
    boundary,
    opacity,
  ]);

  return null;
}
