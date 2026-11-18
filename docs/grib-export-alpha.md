# GRIB export API, sandbox alpha

Enable the companion GRIB Processor plugin to expose the export capability on
compatible forecast datasets. Forecast Dataset Provider receives the request,
holds a read lease on the original version, and manages the temporary result.
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

Follow the job `href` from the 202 response. Poll until `complete` or
`failed`. Follow `result.href` to download a complete result using the same
Signal K identity. The result includes byte size, SHA-256, provenance, expiry,
and the actual message count, spatial bounds and forecast times when applicable.
Use HTTP Range with the result ETag to resume a transfer before expiry.
Identical requests from the same identity can reuse an existing job or result.

The sandbox alpha supports one running job and at most four tracked jobs.
Input and output are each limited to 1 GiB. Results expire after 20 minutes.
Restarting the provider discards its temporary exports. A caller that wants to
keep a dataset can submit it via the existing publication API.

The same endpoint can serve remote acquisition, local route calculations,
and file export for applications such as OpenCPN. The sandbox provides a
GRIB Processor webapp and HTTP API for these tests.
