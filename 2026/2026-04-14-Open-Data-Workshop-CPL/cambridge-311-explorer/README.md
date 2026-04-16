# Cambridge 311 Explorer

Interactive map, timeline, and charts for the City of Cambridge's
[Commonwealth Connect Service Requests](https://data.cambridgema.gov/Public-Works/Commonwealth-Connect-Service-Requests/2z9k-mv9g/about_data)
dataset (all ~145k records, 2009–present).

**Live:** https://brainheart.github.io/cambridge-311-explorer/

## Features

- **Map** with two modes:
  - *Pinpoints* — individual records colored by issue type
  - *Neighborhoods* — choropleth of record density by Cambridge neighborhood
- **Draggable timeline** across the full 17 years of data. Drag the window box to slide, drag the edges to resize, click anywhere to recenter, or scroll-wheel to nudge. Preset window sizes (7d / 30d / 90d / 6mo / 1yr).
- **Animation** — play the timeline forward at 1×, 3×, 7×, 14×, or 30× to watch patterns crawl through time.
- **Filters** — issue type (with search + color swatches), status, neighborhood.
- **Live charts** — top issue types, daily volume, status breakdown — all recompute as filters and window change.

## Running locally

No build step. Just serve the directory over HTTP:

```sh
python3 -m http.server 8765
# open http://localhost:8765/
```

The app fetches data at load time from the Cambridge Socrata API
(`data.cambridgema.gov`), which returns permissive CORS headers so it works
directly from GitHub Pages or any static host.

## Stack

- Vanilla JS, no framework, no bundler
- [Leaflet](https://leafletjs.com/) for the map, CARTO Light basemap
- Custom SVG timeline with native pointer events
- Plain `<canvas>` for the charts
