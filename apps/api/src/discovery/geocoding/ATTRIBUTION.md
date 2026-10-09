# GeoNames attribution

`geonames-cities.data.ts` is generated from GeoNames data:

- `cities15000.zip` and `admin1CodesASCII.txt` from https://download.geonames.org/export/dump/
- Licence: Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/)
- Changes: cities and neighbourhood sections of cities removed (feature codes PPLX, PPLH, PPLQ,
  PPLW, PPLCH); kept only name, plain-ASCII name, state/province, country, coordinates
  (rounded to 3 decimals) and population.

Rebuild with `node apps/api/scripts/build-geonames-dataset.mjs <dir with the two files>`.

"Contains data from GeoNames (www.geonames.org), licensed under CC BY 4.0."
