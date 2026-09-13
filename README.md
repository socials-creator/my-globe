# MyGlobe — Interactive 3D Globe

A touch-friendly, animated 3D globe built for iPhone (and any modern browser). Shows every country/territory/island from `data/world.geojson`, plus continents, oceans, seas, mountain ranges, deserts, rivers and lakes as zoom-aware labels.

## What's inside
- `index.html` — page shell + iOS meta tags
- `style.css` — dark, terracotta-accented design system
- `app.js` — globe setup, zoom-based level-of-detail, search, layer toggles
- `data/world.geojson` — your country/territory polygons (241 features)
- `data/features.js` — curated oceans/seas/mountains/deserts/rivers/lakes (approximate label points, not polygons)
- `icon.png` — home-screen icon

Built on [globe.gl](https://github.com/vasturiano/globe.gl) (three.js) + [d3-geo](https://github.com/d3/d3-geo) for centroid math, both loaded from CDN — no build step, no dependencies to install.

## Deploy to GitHub Pages
1. Create a new GitHub repository (or use an existing one).
2. Upload **all files, keeping the folder structure** (the `data/` folder must stay a folder).
3. In the repo: **Settings → Pages → Source** → select the branch (usually `main`) and `/ (root)` folder → **Save**.
4. Wait ~1 minute, then open the URL GitHub gives you (`https://<username>.github.io/<repo>/`).

That's it — everything is static, no server or API keys required.

## Interaction
- **Drag** to rotate, **pinch or scroll** to zoom (all the way down to the surface).
- **Tap a country** (or search for one) to fly to it and see its name and land borders.
- **Chips** at the top toggle countries, oceans & seas, mountain/desert labels, and river/lake labels.
- Labels appear progressively as you zoom in, so the globe stays clean when zoomed out.

## Notes on accuracy
- Country/territory borders and names come directly from your uploaded `world.geojson`.
- Continents, oceans, seas, mountain ranges, deserts, rivers, and lakes in `data/features.js` are plotted at well-known representative coordinates for label placement — they are not traced polygons, since that geometry wasn't in the source data. Edit or extend that file (plain array of `{ name, lat, lng, category }`) to add or adjust anything.
