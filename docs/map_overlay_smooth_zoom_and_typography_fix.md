# Map Overlay Smooth Zoom + Label Typography Fix

## 1. Existing Map Architecture
The platform utilizes React Leaflet with an ESRI World Imagery satellite tile layer and Leaflet SVG/Tooltip vector overlays for colony boundaries, roads, entry gates, green zones, and plot polygons. Fitted labels rely on dynamic pixel-per-meter scaling (`pxPerMeter`) and bounding metrics (`polyMetrics`) computed in `src/lib/geo.js`.

## 2. Root Cause of Overlay Jumping
- **Continuous Camera Event Mismatch**: In `InteractiveMap.jsx`, the camera event listener `MapWatcher` was listening strictly to `zoomend`. During continuous mouse wheel, trackpad, or pinch gestures, Leaflet's satellite map zoomed smoothly frame-by-frame, whereas the colony overlay's internal `zoom` state and overlay label scale factor remained frozen until the user finished zooming (`zoomend`). This created a visible visual snap/jumping artifact.

## 3. Root Cause of Typography Issue
- **Non-Standard Font Stack & Styling**: Labels rendered using decorative `'Space Grotesk'` and `'JetBrains Mono'` fonts with aggressive letter-spacing (`0.14em`), text shadows, and high-weight contrasts, causing legibility degradation when rendered inside small vector plots/roads.

## 4. Technical Fix & Camera Synchronization
- **Continuous `zoom` Listener**: Refactored `MapWatcher` in `InteractiveMap.jsx` to listen to the continuous `zoom` event via Leaflet's `useMapEvents`. The overlay transform and font scaling now update synchronously with the map camera frame-by-frame.
- **Cartographic Typography**: Updated `map.css` fitted label styles to use a clean modern sans-serif stack (`'Inter'`, `ui-sans-serif`, `system-ui`, `sans-serif`), refined letter spacing (`-0.01em` for plots, `0.05em` for uppercase roads/greens), and crisp halo/shadow effects to ensure high contrast over satellite imagery without text clutter.

## 5. Performance & Verification
- **GIS Geometry Unchanged**: No re-computation of underlying GeoJSON/Leaflet coordinate arrays during zoom operations.
- **Regression Tests**: All 52 backend tests (`node --test tests/*.test.js`) passed.
- **Frontend Production Build**: Vite production build succeeded without errors (`dist/assets/index-BcP7ItJF.css`, `dist/assets/index-BZSopAaa.js`).

## 6. Summary of Files Changed
- `frontend/src/components/InteractiveMap.jsx`
- `frontend/src/map.css`
