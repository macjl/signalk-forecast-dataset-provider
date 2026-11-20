# GRIB export API

Enable the companion GRIB Processor plugin to expose the export capability on
compatible forecast datasets. Forecast Dataset Provider receives the request,
holds a read lease on the original version, and publishes a derived dataset.
The GRIB processor runs ecCodes in a separate process. The plugins discover
each other through a versioned, in-process registry scoped by Signal K data
directory. Restarting either plugin makes new requests observe its current
availability.

## Client flow

1. Read the catalogue and find `operation: "export"` in the dataset's
   `capabilities.operations`. The operation includes a version-specific
   `href`, output format, supported selectors and byte limits. An empty
   operations array means the dataset can only be retrieved as originally
   published.
2. With a Signal K write identity, POST to that `href`. An empty request
   assembles all assets into one GRIB2. Combine selectors in `selection`
   to restrict the export by area, field, time range or any combination.

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
ID order, without repacking. For a time range, supply both `from` and `to`
as UTC timestamps. The limits are inclusive, and the output contains the
original messages whose validity times are in the range. For an accumulation,
validity is the end of the period. The result reports the actual retained
times even if they fall strictly inside the requested interval. Older
processors can advertise a `forecastInterval` with a fixed step and required
fields. This legacy restriction applies only when the operation advertises it.

If the operation lists fields, select from its parameter and level pairs. If
it advertises `fields` without a list, send an ecCodes short name and optional
GRIB level. Each requested field must match at least one message in the
result. A selection that matches no message fails.

The `bbox` selector crops compatible regular latitude-longitude grids. The
automatic inventory supplies the grid bounds and indicates whether the dataset
supports this selector. `pendingSelectors: ["bbox"]` means this check is
pending. Clients can intersect their map bounds with the dataset bounds before
requesting a crop. The result reports the exact envelope of retained grid points.
Discovery filters on the catalogue, such as
`GET /datasets?from=…&to=…`, still use verified inventory coverage.

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

The provider runs up to `maxConcurrentExports` processing workers, two by default.
Background analysis can use one free slot. Each export has its own file and
catalogue result. Input and output per export are each limited to 1 GiB.
The worker writes in the catalogue filesystem. The provider moves the finished
file into staging, reads it once to compute the checksum and commits it
through the same publication path as an upload.
The same endpoint can serve remote acquisition, local route calculations and
file export for clients such as OpenCPN.

## Examples with curl

Set `BASE` to the Signal K server URL, without a trailing slash, and
`TOKEN` to a Signal K bearer token with write access. The commands also use
`jq` to read links and job status.

```sh
API="$BASE/plugins/signalk-forecast-dataset-provider"

curl -fsS -H "Authorization: Bearer $TOKEN" "$API/datasets?format=grib2" |
  jq '.[] | {id, model, forecast, operations: .capabilities.operations}'
```

Pick the dataset ID from that response and follow its advertised operation.
This example selects a time range and a map area. Omit `bbox` to select by
time only, or send `{}` to assemble an entire dataset.

```sh
DATASET_ID='replace-with-dataset-id'
EXPORT=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$API/datasets/$DATASET_ID" |
  jq -er '.capabilities.operations[] | select(.operation == "export") | .href')

JOB=$(curl -fsS -H "Authorization: Bearer $TOKEN" \
  --json '{"selection":{"from":"2026-11-18T12:15:00Z","to":"2026-11-18T18:15:00Z","bbox":[5,42,7,44]}}' \
  "$BASE$EXPORT")
printf '%s\n' "$JOB" | jq '{state, href}'
```

Poll the job link with the same identity. Once `state` is `complete`,
download the generated file through its normal catalogue asset URL.

```sh
JOB_HREF=$(printf '%s\n' "$JOB" | jq -er '.href')
RESULT=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE$JOB_HREF")
printf '%s\n' "$RESULT" | jq '{state, error, actual: .result.actual}'
ASSET=$(printf '%s\n' "$RESULT" | jq -er 'select(.state == "complete") | .result.assets[0].href')
curl -fsS -H "Authorization: Bearer $TOKEN" -o selection.grib2 "$BASE$ASSET"
```
