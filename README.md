# Forecast Dataset Provider

Signal K Resource Provider for **`forecastDatasets`**: a shared catalogue of persistent, immutable forecast content. Downloaders and receivers publish original bytes; routing, weather and navigation clients discover and retrieve them without depending on private directories.

**Version 0.1.0 is the first stable catalogue release.** It implements staged multi-asset publication (including unknown-size streams), live publication progress, SHA-256 content versions, resumable publication after restart, verified-inventory enrichment, filtered discovery, HTTP Range/HEAD/ETag access, deletion coordination and v2 resource deltas. No GRIB/Zarr decoder is bundled. Formats are declared, not detected or validated meteorologically.

The architecture and examples come from the [project outline](https://github.com/macjl/signalk-grib-resources/blob/c289876e4d4e5faadbb6779d865d7aa21a0d9822/docs/project-outline.md). The wire contract selected for this prototype is documented in [contract 0.1](docs/contract-v0.1.md); it is experimental, not an adopted Signal K specification.

## Install

Requires **Signal K server 2.34 or later within 2.x** and Node.js 20.19 or later for this plugin (the server may require a newer Node version). The target server for integration verification is 2.34.0.

See the [coordinated upgrade guide](docs/upgrading.md) before upgrading the downloader and Weather Provider from local-file releases. The complete chain requires Node.js 24+.

Install the stable release from the Signal K App Store or from its configuration directory:

```sh
npm install signalk-forecast-dataset-provider@latest
```

Restart the server and enable **Forecast Dataset Provider** in Plugin Config. To build a local archive from source:

```sh
npm ci
npm run check
npm pack
```

Install the resulting archive using the server's normal plugin installation workflow, for example `npm install /path/to/signalk-forecast-dataset-provider-0.1.0.tgz` from its configuration directory. No npm release is required for local testing.

The default storage location is `<plugin data directory>/catalogue`. An optional absolute `storageDirectory` can be configured. Use a local filesystem supporting hard links and atomic rename, with a single catalogue writer. Limits are configurable for asset bytes, dataset bytes, asset count and unfinished publications. They are per-publication limits, not an automatic total-disk-quota policy. Unfinished publications persist until resumed or explicitly aborted.

Size limits in Plugin Config use **MiB** (French: Mio): 1 MiB = 1,048,576 bytes, not megabits. Configuration defaults are:

```json
{
  "maxAssetMiB": 2048,
  "maxDatasetMiB": 8192,
  "maxAssets": 1024,
  "maxStaging": 16
}
```

Decimal MiB values are accepted and converted to whole bytes by rounding down. The API's asset sizes, progress counters, indexes and HTTP byte ranges remain in bytes. There is no migration or compatibility alias for the byte-based configuration keys of unpublished development snapshots; update those development configurations directly.

Do not also configure the built-in Resources Provider to serve a custom `forecastDatasets` collection: this plugin owns the collection and its semantics.

## Publish and retrieve

All custom paths below start at `/plugins/signalk-forecast-dataset-provider`. Authenticate with the same Signal K server token you use for other APIs. Producers need `readwrite` access; inventory assertions require an administrator/indexer with admin access. All writers share the publication namespace in v0.1; the producer label is descriptive, not a per-user ACL.

1. `POST /publications` with the declared asset IDs and optional exact byte lengths/SHA-256 digests.
2. `PUT /publications/{publication}/assets/{asset}` with unencoded `application/octet-stream` bytes for each asset.
3. `POST /publications/{publication}/commit` once every asset is uploaded. The resource becomes discoverable only after this atomic commit.
4. Discover summaries at `/signalk/v2/api/resources/forecastDatasets` and retrieve a resource at `/signalk/v2/api/resources/forecastDatasets/{id}`. Follow its version-bound asset URLs.

For another version of an existing dataset, begin with `POST /datasets/{id}/publications`. Older committed versions remain readable. A failed upload does not discard other completed assets: read the private publication status and send only the missing assets. Partial files are discarded; partial-byte upload resume is not implemented.

When a source does not announce its size, omit asset `size` and stream the source directly into the upload request. The provider counts bytes and hashes them while writing; declared sizes/hashes, when present, remain checked expectations. Configured asset and cumulative dataset limits apply during reception, including completed assets and known-size reservations. Empty uploads are rejected.

The downloader must propagate upstream errors by aborting the upload and only commit after successful acquisition of every asset. A hash calculated from the received bytes does not prove upstream completeness or meteorological validity. No intermediate downloader file is required by this API, but downloaders must implement direct streaming explicitly.

Writers can poll `GET /publications` or `GET /publications/{id}` for `state` (`pending`, `receiving`, `ready`) and byte/file `progress`. `ready` means received and awaiting explicit commit, not published. `totalBytes: null` means unknown, not zero. These no-store endpoints are separate from the complete-dataset collection and remain readwrite-only. Progress for a currently receiving file is volatile; only completed uploads survive restart. Forecast Dataset Browser 0.1.1 can display this monitoring separately.

Assets and indexes are served to external HTTP clients without requiring shared filesystem access. A request such as `Range: bytes=0-1023` reads the exact original representation. Multi-range responses are not implemented; use separate requests for separate messages.

Signal K 2.34's scoped plugin router cannot declare `HEAD` as readonly: its security layer matches the exact method, so `HEAD` requires admin access on that server version. Readonly clients can use `GET` (including `Range`) instead. This plugin does not bypass server security to change that behaviour.

The plugin's OpenAPI document is exposed through Signal K's API documentation. See [the contract](docs/contract-v0.1.md) for request/response examples, identity rules, filters, conditional requests, sparse metadata and deletion semantics.

## Verified inventory

An independent trusted indexer can publish metadata plus an opaque index to `PUT /datasets/{id}/versions/{version}/inventory`, with `If-Match` set to that version's current detail ETag. The catalogue binds the index to the content version and asset hashes and checks message byte bounds if supplied. It does not decode GRIB or independently certify an indexer's meteorological assertions.

Publication completeness and inventory verification are distinct. A radio-received file can be published with sparse metadata and remain downloadable before indexing. Strict coverage/field filters exclude unknown inventory rather than treating requested data as verified. Large indexes live on disk and are retrieved separately from catalogue summaries.

## Next pieces

The catalogue works without processors. In v0.1 the advertised `operations` array is empty. Automatic indexer registration, processor dispatch, temporary subset jobs and isolated GRIB workers belong to the next implementation stage; no transform capability is advertised prematurely. A concrete GRIB indexer can already use the enrichment interface independently.

Persistent derived datasets can use the ordinary producer API and supply provenance. Runtime temporary-result handling, spatial subsetting, Zarr/harmonic processing, federation, archival policies and shared decoded caches are not implemented in this version. The Weather API is unchanged.

## Development and verification

```sh
npm ci
npm run check
```

Tests exercise real HTTP transfers, original binary bytes and hashes, Range/HEAD/validators, declared access levels, metadata revisions, antimeridian discovery, crash/restart recovery and retention/read conflicts. Synthetic binary fixtures test the catalogue transport; they do not prove GRIB decoding compatibility. OpenAPI is validated as part of the test suite.

[Sandbox verification](docs/sandbox-verification.md) records the actual Signal K server checks and the deployment helper's scope.

## Publishing

See [RELEASING.md](RELEASING.md) for npm bootstrap, OIDC trusted-publisher configuration and the GitHub Release workflow. Beta releases publish under the `beta` dist-tag and do not promote themselves to `latest`.

License: Apache-2.0.
