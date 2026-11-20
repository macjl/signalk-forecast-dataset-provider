# Changelog

This changelog groups changes by stable release. See [GitHub Releases](https://github.com/macjl/signalk-forecast-dataset-provider/releases) for prerelease notes.

## 0.4.0 — 2026-11-21

- Add in-process publication, discovery and streaming of versioned assets for companion plugins running in the same Signal K instance.
- GRIB Downloader and GRIB Weather Provider 0.8.0 can use the catalogue without a device access request. Notifications, retention and the existing HTTP API remain available to catalogue clients.

## 0.3.0 — 2026-11-20

- **GRIB2 exports.** With GRIB Processor enabled, serve single-file GRIBs and
  advertise supported area, field and forecast-time selections per dataset.
  Time ranges use actual forecast validity times, including irregular steps.
  Run two exports in parallel by default and publish their results as separate
  datasets with source provenance and a default lifetime of 20 minutes.
- **Verified inventories.** Measure validity times, geographic coverage and
  grid compatibility with GRIB Processor, including for eligible datasets
  already in the catalogue. Original assets, versions and indexes are preserved.
- **Dataset expiration.** Producers can choose a lifetime at publication.
  Expired datasets leave discovery and their storage is reclaimed after active
  readers finish.
- Recommend GRIB Processor in the Signal K App Store. The catalogue can run
  independently on Node.js 22 or later. See the [export API examples](docs/grib-export-alpha.md).

## 0.2.0 — 2026-10-31

- Require Node.js 22 or later, dropping Node.js 20 support. Align Node.js
  development types with version 22 and test on Node.js 22/24.
- Upgrade Express to 5 and validate named route parameters explicitly. Cover
  the HTTP lifecycle against both Express 4 hosts and Express 5 hosts.
- Upgrade to TypeScript 7 with Node16 module resolution, preserving CommonJS
  output for Signal K plugin loading.
- Update Signal K development API types to 2.35 and the OpenAPI validator to 13.
  Development checks require Node.js 22.19+; installed runtime code supports 22+.
- Separate major dependency migrations from routine Dependabot updates; keep
  Express and its types together and Node.js types on the supported baseline.
- Keep storage, settings, dataset identities and HTTP contract 0.1 unchanged.
- Verify Signal K 2.34.0/2.35.1 integration and the existing sandbox deployment.

## 0.1.1 — 2026-10-31

- Enable Forecast Dataset Provider by default on fresh installations, so the
  catalogue is available without a separate activation step.
- Preserve existing explicit enabled/disabled settings through Signal K's
  standard activation behaviour. Already-disabled installations still require
  enabling the provider once in Plugin Config.
- Keep storage, permissions and HTTP contract 0.1 unchanged.

## 0.1.0 — 2026-10-30

- First stable `forecastDatasets` catalogue. Stream multi-asset publications
  with known or unknown sizes, measure size and SHA-256 on receipt, and show
  live progress to writers. Completed assets can be reused after a restart.
- Discover immutable datasets and download version-bound assets with HTTP
  Range, HEAD and ETag support. Trusted indexers can add metadata and indexes
  for verified coverage and field filters. Publish v2 resource notifications
  and coordinate deletions with active readers.
- Configure the per-asset and per-dataset size limits in MiB.
- Update the Express 4 lockfile to body-parser 1.20.9, fixing GHSA-27r3-jxmh-p828.
- Document the coordinated Downloader 0.4.0 / Weather Provider 0.7.0 upgrade,
  Node 24 requirement for the complete chain and separate access approvals.
- Keep HTTP contract 0.1 and original dataset identities unchanged. No decoder,
  processor dispatch or subsetting service is bundled.
