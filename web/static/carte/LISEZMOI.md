# Fond de carte

Servi par le site lui-même : aucun visiteur ne contacte un service de cartographie extérieur.

- `polices/` : glyphes Noto Sans (Regular, Medium, Italic) au format PBF, licence SIL OFL (`polices/OFL.txt`).
- `icones/` : feuilles d'icônes Protomaps v4 (clair et sombre), licence BSD-3 (`icones/LICENSE-BSD3.md`).
  Source : github.com/protomaps/basemaps-assets, commit 028c18f713ba (31 octobre 2025).
- Les tuiles (`france.pmtiles`, 5,5 Go, hors dépôt git) : extrait de la carte Protomaps (données
  OpenStreetMap, ODbL — attribution « © OpenStreetMap » obligatoire sur la carte), découpé au contour de
  la France, outre-mer compris (`cartes/france-region.geojson`) :
  `pmtiles extract https://build.protomaps.com/AAAAMMJJ.pmtiles cartes/france.pmtiles --region=cartes/france-region.geojson`
  En développement, `web/static/carte/france.pmtiles` est un lien vers `cartes/france.pmtiles`.
