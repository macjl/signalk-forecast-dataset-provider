# Forecast Dataset Provider — experimental contract 0.1

This document records prototype choices left open in the [project outline](https://github.com/macjl/signalk-grib-resources/blob/c289876e4d4e5faadbb6779d865d7aa21a0d9822/docs/project-outline.md). It describes implemented behaviour, not a final Signal K standard. Resource type: `forecastDatasets`. Plugin base: `/plugins/signalk-forecast-dataset-provider`.

## Publication

`POST /publications` creates a private staging publication and allocates a dataset ID. Example JSON:

```json
{
  "kind": "forecast",
  "format": "grib2",
  "producer": "signalk-grib-downloader",
  "metadata": { "name": "Example acquisition", "model": "GFS" },
  "requested": { "durationHours": 48 },
  "provenance": { "channel": "internet" },
  "assets": [
    { "id": "wind", "size": 1024, "mediaType": "application/octet-stream" },
    { "id": "pressure", "size": 512 }
  ]
}
```

If supplied, the example lengths must be replaced with actual expected file sizes; omit `size` entirely when unknown. The response has status 201 and a `Location` pointing to the publication. It contains `id` (the publication UUID), `datasetId`, `createdAt`, `declaration`, the initially empty `uploaded` map, plus the staging `state` and `progress` described below.

Required fields are `kind` (`forecast`, `analysis` or `harmonic`), a lowercase `format` identifier, a descriptive `producer` label and a non-empty `assets` array. Other formats may be stored without implying any processing support. `metadata` defaults to an empty object. Optional asset SHA-256 digests must be 64 lowercase hex digits and are checked during upload.

Asset identifiers contain ASCII letters, digits, `_` and `-`, start with an alphanumeric character, and are at most 128 characters. Duplicate or case-colliding IDs, reserved prototype keys, paths, invalid/out-of-limit declared sizes and unknown declaration properties are rejected. `size` is optional since package 0.1.1 (an additive extension of contract 0.1); `null` is not a valid size. Supplied sizes must be positive safe integers. Metadata keys are `name`, `description`, `model`, UTC `run`, WGS84 `bounds`, `forecast`, `fields` and opaque `grid`. `requested` and `provenance` are bounded JSON objects; publish only information intended for authenticated catalogue readers.

`PUT /publications/{publication}/assets/{asset}` accepts raw, unencoded `application/octet-stream` bytes. A positive `Content-Length` is optional; when both it and a declared size exist they must match. Chunked requests do not require a preliminary HEAD request or local file. The provider measures actual size and SHA-256 during reception, and checks any supplied expectations at completion. The returned asset always has measured `size` and `sha256`. Empty uploads are rejected.

Configured per-asset and per-dataset limits are enforced during reception, even when sizes are unknown. Uploads are serialised per publication; the dataset budget counts other completed assets at their measured sizes and reserves known sizes of unfinished assets. Rejected or broken uploads discard their partial file, release its budget and preserve all other completed assets. Over-limit or broken chunked streams may be terminated rather than yield a JSON error; check publication status before retrying. Accepted files are fsynced and renamed to their completed asset ID. The request has a 120-second socket inactivity timeout.

`GET /publications/{publication}` returns staging status for writers. Completed assets appear in `uploaded`, with `id`, `size`, `sha256` and `mediaType`. Re-uploading a finished asset returns 409. Interrupted partial files are removed after an error or recovery, while finished uploads (including originally unknown-size ones) are rehashed on startup and preserved. Resume at the asset level; no partial-byte resume is claimed.

`GET /publications` returns a map keyed by publication UUID, newest-created first. It is bounded by `maxStaging`, not paginated, and includes only unfinished publications. Both GET endpoints are readwrite-only, use `Cache-Control: no-store`, and add the following live view without changing the persisted staging manifest:

```json
{
  "state": "receiving",
  "progress": {
    "bytesReceived": 4096,
    "totalBytes": null,
    "assetsCompleted": 0,
    "assetsTotal": 1,
    "assets": {
      "wind": {
        "state": "receiving",
        "bytesReceived": 4096,
        "totalBytes": null
      }
    }
  }
}
```

Publication states are `pending` (waiting, interrupted or partially completed), `receiving` (an active upload) and `ready` (all assets received, still awaiting explicit commit). Per-asset states are `pending`, `receiving`, `complete`. Byte progress includes completed assets plus the accepted bytes of the active stream, not a durability guarantee. Total bytes are null while any asset has neither a declared size nor a completed measured size; clients must not invent a percentage. Totals become exact after every upload completes. Live partial progress is kept in memory only; after failure/restart it returns to zero for that asset. A producer may retry later, so `pending` does not imply an active network transfer. Polling these endpoints does not enumerate partial content through Resources API or make it downloadable. No progress delta/event stream is promised by this extension.

The producer must propagate upstream read errors by aborting its upload, and commit only after confirming that acquisition succeeded. A normally terminated, unknown-size stream cannot by itself reveal that an upstream application silently returned incomplete content. The calculated hash identifies received bytes, not completeness, authenticity or GRIB validity. Validation of declared length/hash and publication completeness remains separate from format inspection by an indexer.

`POST /publications/{publication}/commit` returns 409 if any declared asset is missing. On success it returns 201 and the complete resource, with a version-bound detail `Location`. Publication does not require indexing or combining assets. Its scope is the declared files, not every file or step available in an upstream model.

`POST /datasets/{id}/publications` creates a new staged version for an existing dataset. Previously committed versions remain retrievable. An identical content version preserves its original declaration and inventory rather than replacing provenance with the new request. Use a separate dataset ID for distinct acquisition histories you need to retain separately.

Commit removes the staging entry. If its successful HTTP response was lost, a retry may find the publication gone: use the `datasetId` from the original declaration response to inspect the committed resource before re-uploading. This version does not provide an indefinite completed-publication receipt ledger.

`DELETE /publications/{publication}` aborts staging and releases its files. It does not delete an already published dataset. Unfinished content is not returned by public catalogue discovery.

## Content versions and storage ownership

Dataset IDs are server-generated UUIDs. A content `version` is a SHA-256 digest over canonical JSON containing `kind`, `format` and the completed asset descriptors (`id`, `size`, `sha256`, `mediaType`), sorted by asset ID in ASCII order. Object keys sort lexicographically by UTF-16 code unit; array order is retained. Strings are not Unicode-normalised. This is a prototype-specific canonicalisation, not a claim of RFC 8785 compatibility.

Descriptive metadata, producer labels, provenance and inventory enrichment do not determine byte identity. `metadataRevision` starts at 1 and increases on inventory updates. It is independent of content `version` and the per-asset byte hashes.

The catalogue owns uploaded files. Hard links let staging and a prepared version share bytes until the head/history manifest is atomically committed. Only versions named by that manifest are published. Recovery preserves finished staging content even if the previous process failed while preparing a version. Storage must be a single-writer local filesystem with hard-link and atomic-rename support; do not edit its managed files externally.

On startup published assets are checked for existence, regular-file type and byte length. They are not all rehashed on every startup; hashes were computed on upload. Missing or changed-size published content causes a startup error instead of silently advertising it. Offline bit-rot verification is outside this version's scope.

## Discovery and detail

`GET /signalk/v2/api/resources/forecastDatasets` returns a map keyed by dataset ID. Each value summarises the latest complete version and contains identity, revision, provenance-free descriptive metadata, inventory state, total size, asset count, an empty operations list, and the detail `href`. Assets and index messages are omitted from summaries. The plugin also exposes `/datasets` with the same listing semantics and explicit HTTP error responses.

`GET /signalk/v2/api/resources/forecastDatasets/{id}` or plugin `/datasets/{id}` returns detail. It adds `declared` metadata, any explicitly published `requested`/`provenance` objects and `assets[]` with stable version-bound `href`, byte size, hash, media type and `byteRanges: true`. Top-level descriptive fields merge declared metadata with supplied verified metadata. They are a convenience view: an inventory flag is not proof that every declared field was verified; the linked inventory identifies the actual verified keys.

`GET /datasets/{id}/versions/{version}` reads a particular committed version. A subsequent run does not rewrite older asset URLs. JSON detail and index responses have ETags and `Cache-Control: private, no-cache, no-transform`.

Implemented discovery filters:

| Filter                                | Meaning                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `format`, `kind`, `producer` | Exact, case-sensitive match. Model may come from declared metadata if unverified.                                                                                                                                                  |
| `state`                               | Only `complete` is accepted. Partial acquisition belongs to private staging.                                                                                                                                                       |
| `verified`                            | `true` selects resources with an inventory assertion; `false` selects those without.                                                                                                                                               |
| `bbox`                                | `west,south,east,north` in degrees, or a JSON array. West/east are in −180..180; west greater than east crosses the antimeridian.                                                                                                  |
| `from`, `to`                          | UTC ISO timestamps selecting forecast validity, distinct from run or arrival time.                                                                                                                                                 |
| `coverage`                            | `contains` by default: advertised bounds/period must contain the requested bounds/period. `overlaps` accepts intersections, inclusive of boundaries.                                                                               |
| `fields`                              | A JSON array of `{parameter, level?}` selectors. All requested fields must be verified. Level compares type, numeric value and unit exactly; no unit conversion occurs. Omit the whole level to match any level of that parameter. |
| `sort`                                | `run` descending by default, or `createdAt` descending. Unknown runs sort after known runs; creation time and ID break ties.                                                                                                       |
| `limit`, `offset`                     | Default limit 100, maximum 1000; non-negative offset. No snapshot/pagination token is promised during concurrent catalogue changes.                                                                                                |

Coverage, time and field predicates use **only verified metadata**. Unknown inventory cannot satisfy them. Declared requests such as “48-hour wind” are never used as proof of actual coverage. A verified inventory with no coverage key still cannot satisfy a coverage query. The initial filters use the indexer's summary coverage; per-field/per-step coverage matching is not implemented and must not be inferred from a summary match.

Examples:

```text
GET /signalk/v2/api/resources/forecastDatasets?format=grib2&state=complete
GET /plugins/signalk-forecast-dataset-provider/datasets?model=GFS&verified=true
GET /plugins/signalk-forecast-dataset-provider/datasets?bbox=175,0,-175,10&coverage=contains
```

Unknown filters or invalid values are rejected. The Signal K core aggregates Resource Provider errors in its own way; use the plugin `/datasets` endpoint to receive this contract's explicit 400 errors. Generic Resource API writes are deliberately rejected: JSON CRUD cannot bypass asset staging and checksum validation. Generic DELETE is implemented, with the core emitting its normal deletion delta.

## Original content

Follow the asset URLs. `GET` and `HEAD` return the declared media type (default `application/octet-stream`), `Content-Length`, `Accept-Ranges: bytes`, strong `ETag: "sha256-<digest>"`, attachment disposition and `Cache-Control: private, max-age=31536000, immutable, no-transform`.

One `Range: bytes=start-end`, `bytes=start-` or `bytes=-suffix` yields 206 and `Content-Range`. Unsupported multi-ranges and unsatisfiable/malformed byte ranges yield 416 with `Content-Range: bytes */<size>`. No decompression, concatenation or conversion occurs. A non-matching `If-Range` yields the full representation; strong matching asset ETags enable a range. Date-based If-Range is not implemented and falls back to full content. `If-None-Match` supports cached GET/HEAD revalidation.

Original bytes and detailed indexes are separate transfers. Clients must use the asset/version identity from the index and check their decoder's compatibility. No global model selection or interpolation policy is imposed.

## Inventory enrichment

An admin-authorised indexer first GETs version detail and its ETag, then sends `PUT /datasets/{id}/versions/{version}/inventory` with `If-Match` equal to that ETag. Example JSON:

```json
{
  "metadata": {
    "model": "GFS",
    "fields": [
      {
        "parameter": "eastward_wind",
        "level": { "type": "heightAboveGround", "value": 10, "unit": "m" }
      }
    ]
  },
  "index": {
    "messages": [
      {
        "assetId": "wind",
        "offset": 0,
        "length": 1024,
        "parameter": "eastward_wind"
      }
    ]
  }
}
```

The example assumes the message really occupies those bytes; only the indexer can assert that. If `index.messages` is supplied, the catalogue checks that each asset exists and its integer byte span fits the asset. It does not parse headers or verify field semantics. Native GRIB identifiers, templates, exact forecast steps and other format-specific details can be carried in the opaque index. The GRIB index profile remains work for the separate indexer.

A missing If-Match returns 428; a stale metadata revision returns 412. Enrichment writes a separately hashed index on disk, atomically updates record metadata and increments `metadataRevision`. The asset bytes, content version and asset ETags are unchanged. The full linked index is not retained in the in-memory catalogue.

`GET /datasets/{id}/versions/{version}/index` returns the exact source version, metadata revision, asset IDs/sizes/hashes, verified metadata and supplied index. Without enrichment it returns 404. Malformed/failed enrichment leaves existing metadata and original content usable. Complete publication and verified inventory are independent.

## Notifications, deletion and lifecycle

Custom publication, enrichment of the current head and deletion emit deltas at `resources.forecastDatasets.<id>` with target version `v2`. Delete uses `null`. The provider does not populate the v1 full model. Clients must still perform an initial listing and resynchronise after reconnecting; notifications are not a durable event log.

`DELETE /datasets/{id}` deletes all committed versions, but returns 409 while a reader or an unfinished version publication uses that dataset. Deletion blocks new reads before moving content to a tombstone; unfinished tombstone cleanup is completed on startup. A plugin stop refuses new operations and waits for accepted mutations and active reads before closing. Signal K handles Resource Provider deregistration during plugin shutdown.

Advanced retention policies, per-version deletion, automatic staging expiry and global storage quotas are not implemented. Admins can inspect/abort known unfinished publication IDs and delete idle datasets through this API.

## Access and future processors

Plugin reads are declared `readonly`; publication, staging status and deletion are `readwrite`; inventory assertions remain admin-only. The Signal K server authenticates requests. There is no new anonymous-access bypass or token store. Staging is private to writers, not isolated between individual writer identities. Relative `href`s should be resolved against the client's server origin/proxy prefix; Signal K's CORS policy governs external browser clients.

Server 2.34 limitation: the scoped router has no `HEAD` registration and its security layer matches the exact HTTP method, so `HEAD` falls back to admin-only even for a readonly `GET` route. Use `GET`/`Range` with readonly credentials. The plugin does not patch or bypass the server's permission system.

`GET /status` reports contract version, dataset count and `operations: []`. Processor registration/availability, delegated temporary jobs, output handover/expiry, worker isolation and subsetting are reserved for the next piece. In particular the prototype neither installs decoders nor promises `spatialSubset` based on the upstream downloader's capabilities.
