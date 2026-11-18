# GRIB export API, sandbox alpha

Enable the companion GRIB Processor plugin to expose the export capability on
compatible forecast datasets. Forecast Dataset Provider receives the request,
holds a read lease on the original version, and publishes a derived dataset.
The GRIB processor runs ecCodes in a separate process. The plugins discover
each other through a versioned, in-process registry scoped by Signal K data
directory. Restarting either plugin makes new requests observe its current
availability.

Read the catalogue as usual. Each dataset version's
`capabilities.operations` describes its export profile and supported selectors.
Submit an authenticated write request to the plugin.

```http
POST /plugins/signalk-forecast-dataset-provider/datasets/{id}/versions/{version}/requests
Content-Type: application/json
```

```json
{
  "operation": "export",
  "output": { "format": "grib2", "layout": "single-file" },
  "selection": {
    "bbox": [-6, 44, -1, 48],
    "fields": [
      { "parameter": "eastward_wind" },
      { "parameter": "northward_wind" },
      { "parameter": "air_pressure_at_mean_sea_level" }
    ],
    "from": "2026-11-09T15:00:00Z",
    "to": "2026-11-10T03:00:00Z"
  }
}
```

Omit selection to concatenate all complete GRIB2 messages, in ascending asset
ID order, without repacking. The spatial selectors in this alpha support the
AROME SP1 0.025-degree assets published by GRIB Downloader. Wind defaults to
the 10 m level. If using an interval, both limits are inclusive UTC hours and
every requested field must be present at every requested hour. The reported
bounds give the exact envelope of retained grid points.

Follow the job `href` from the 202 response and poll until `complete` or
`failed`. On completion, `result` describes a normal catalogue dataset.
Read `result.href` or download `result.assets[0].href` through the standard
dataset API, including HTTP Range. The dataset retains source and processor
provenance, size and SHA-256. `result.actual` describes the verified output
message count and, where applicable, bounds and forecast times.

Exports expire 20 minutes after commit by default. Set top-level
`expiresInSeconds` to choose another lifetime, or use
`"expiresInSeconds": null` to keep the derived dataset without expiration.
A published result survives a provider restart until its expiry. Job status
and deduplication are kept in memory. Identical requests by the same identity
can reuse an existing job or an accessible result. Authorised catalogue
readers can discover and use the derived dataset.

The sandbox alpha runs one export at a time. Input and output are each limited
to 1 GiB. The processor's working file is removed once publication finishes.
The same endpoint can serve remote acquisition, local route calculations and
file export for clients such as OpenCPN.
