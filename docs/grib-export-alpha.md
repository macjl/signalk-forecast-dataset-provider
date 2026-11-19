# GRIB export API, beta

Enable the companion GRIB Processor plugin to expose the export capability on
compatible forecast datasets. Forecast Dataset Provider receives the request,
holds a read lease on the original version, and publishes a derived dataset.
The GRIB processor runs ecCodes in a separate process. The plugins discover
each other through a versioned, in-process registry scoped by Signal K data
directory. Restarting either plugin makes new requests observe its current
availability.

## Client flow

1. Read the catalogue and find the export entry in `capabilities.operations`.
   It includes the version-specific `href`, output format, selectors, and byte
   limits. Spatial profiles also describe selectable fields and time steps.
2. With a Signal K write identity, POST to that `href`. An empty request exports
   all assets into one GRIB2. To limit the export, send a selection like this:

   ```json
   {
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

3. A `202` includes the job `href` and `Retry-After`. Poll the job with the same
   identity. A repeated request can return `200` with a completed result
   immediately. If a different job is occupying the worker, retry the
   `429` after the indicated delay.
4. On `complete`, download `result.assets[0].href` with the standard catalogue
   API, including HTTP Range. `result.href` links to the exact dataset version.
   Authorised catalogue readers can use the result with their own identity.

The request and job routes are also described in the provider's OpenAPI.
Requests may still explicitly include `"operation":"export"` and
`"output":{"format":"grib2","layout":"single-file"}`.

Omit selection to concatenate all complete GRIB2 messages, in ascending asset
ID order, without repacking. The spatial selectors in this beta support the
AROME SP1 0.025-degree assets published by GRIB Downloader. Wind defaults to
the 10 m level. If using an interval, both limits are inclusive UTC hours and
every requested field must be present at every requested hour. The reported
bounds give the exact envelope of retained grid points.

The advertised fields describe the processor profile. When an original has no
verified inventory, discover candidates by model and give the requested area
and times to the export. The worker checks the actual messages and returns
`failed` if it cannot satisfy the selection. Metadata, index and coverage
filters on the catalogue retain their existing verified semantics.

The result includes source and processor provenance, size and SHA-256.
`result.actual` describes the output message count and, where applicable,
bounds and forecast times.

Exports expire 20 minutes after commit by default. Set top-level
`expiresInSeconds` to choose another lifetime, or use
`"expiresInSeconds": null` to keep the derived dataset without expiration.
A published result survives a provider restart until its expiry. Job status
and deduplication are kept in memory. Identical requests by the same identity
can reuse an existing job or an accessible result. Authorised catalogue
readers can discover and use the derived dataset. While the job is still
available, its status is `expired` if the result has already left the catalogue.

The beta runs one export at a time. Input and output are each limited
to 1 GiB. The worker writes in the catalogue filesystem. The provider moves the finished
file into staging, reads it once to compute the checksum and commits it
through the same publication path as an upload.
The same endpoint can serve remote acquisition, local route calculations and
file export for clients such as OpenCPN.
