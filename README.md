# Forecast Dataset Provider

Signal K Resource Provider for **`forecastDatasets`**: a shared catalogue of persistent, immutable forecast content. Downloaders and receivers publish original bytes; routing, weather and navigation clients discover and retrieve them without depending on private directories.

**Version 0.1.0 is the catalogue foundation.** It implements staged multi-asset publication, SHA-256 content versions, resumable publication after restart, verified-inventory enrichment, filtered discovery, HTTP Range/HEAD/ETag access, deletion coordination and v2 resource deltas. No GRIB/Zarr decoder is bundled. Formats are declared, not detected or validated meteorologically.

The architecture and examples come from the [project outline](https://github.com/macjl/signalk-grib-resources/blob/c289876e4d4e5faadbb6779d865d7aa21a0d9822/docs/project-outline.md). The wire contract selected for this prototype is documented in [contract 0.1](docs/contract-v0.1.md); it is experimental, not an adopted Signal K specification.

## Install

Requires **Signal K server 2.34 or later within 2.x** and Node.js 20.19 or later for this plugin (the server may require a newer Node version). The target server for integration verification is 2.34.0.

Install a built npm archive in the Signal K configuration directory, then restart the server and enable **Forecast Dataset Provider** in Plugin Config. Until a registry release exists, build from source:

```sh
npm ci
npm run check
npm pack
```

Install the resulting archive using the server's normal plugin installation workflow, for example `npm install /path/to/signalk-forecast-dataset-provider-0.1.0.tgz` from its configuration directory. No npm release is required for local testing.

The default storage location is `<plugin data directory>/catalogue`. An optional absolute `storageDirectory` can be configured. Use a local filesystem supporting hard links and atomic rename, with a single catalogue writer. Limits are configurable for asset bytes, dataset bytes, asset count and unfinished publications. They are per-publication limits, not an automatic total-disk-quota policy. Unfinished publications persist until resumed or explicitly aborted.

Do not also configure the built-in Resources Provider to serve a custom `forecastDatasets` collection: this plugin owns the collection and its semantics.

## Publish and retrieve

All custom paths below start at `/plugins/signalk-forecast-dataset-provider`. Authenticate with the same Signal K server token you use for other APIs. Producers need `readwrite` access; inventory assertions require an administrator/indexer with admin access. All writers share the publication namespace in v0.1; the producer label is descriptive, not a per-user ACL.

1. `POST /publications` with the declared assets and their exact byte lengths.
2. `PUT /publications/{publication}/assets/{asset}` with unencoded `application/octet-stream` bytes for each asset.
3. `POST /publications/{publication}/commit` once every asset is uploaded. The resource becomes discoverable only after this atomic commit.
4. Discover summaries at `/signalk/v2/api/resources/forecastDatasets` and retrieve a resource at `/signalk/v2/api/resources/forecastDatasets/{id}`. Follow its version-bound asset URLs.

For another version of an existing dataset, begin with `POST /datasets/{id}/publications`. Older committed versions remain readable. A failed upload does not discard other completed assets: read the private publication status and send only the missing assets. Partial files are discarded; partial-byte upload resume is not implemented.

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

License: Apache-2.0.
