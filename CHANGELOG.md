# Changelog

## 0.1.1 — 2026-10-31

- Enable Forecast Dataset Provider by default on fresh installations, so the
  catalogue is available without a separate activation step.
- Preserve existing explicit enabled/disabled settings through Signal K's
  standard activation behaviour. Already-disabled installations still require
  enabling the provider once in Plugin Config.
- Keep storage, permissions and HTTP contract 0.1 unchanged.

## 0.1.0 — 2026-10-30

- First stable catalogue release, promoting the tested streaming publication,
  immutable multi-asset storage, discovery, transport and progress-monitoring API.
- Update the Express 4 lockfile to body-parser 1.20.9, fixing GHSA-27r3-jxmh-p828.
- Document the coordinated Downloader 0.4.0 / Weather Provider 0.7.0 upgrade,
  Node 24 requirement for the complete chain and separate access approvals.
- Keep HTTP contract 0.1 and original dataset identities unchanged. No decoder,
  processor dispatch or subsetting service is bundled.

## 0.1.0-beta.1 — 2026-10-21

- First public beta of the format-agnostic `forecastDatasets` catalogue and original-content provider; experimental contract 0.1.
- Include immutable multi-asset publication, unknown-size streaming, measured SHA-256/size, explicit commit, restart recovery and writer-only progress monitoring.
- Include trusted index enrichment, filtered discovery, version-bound Range/HEAD/ETag downloads, v2 resource notifications and coordinated deletion.
- Configure size limits in MiB. No bundled format decoder, subsetting processor or processor dispatch is advertised.
- Publish with npm OIDC/provenance through GitHub Releases, under the `beta` dist-tag without changing `latest`.
- Verify the same publication/transport tests on Windows, using a writable non-truncating handle for the durable file flush.

## Development snapshots (not published to npm)

### 0.1.2 — 2026-10-21

- Configure size limits in MiB (`maxAssetMiB: 2048`, `maxDatasetMiB: 8192`), keeping internal/API byte accounting and the same default thresholds.
- Clarify units in Plugin Config and validate fractional MiB values. No configuration migration or legacy aliases are provided for this unpublished prototype.

### 0.1.1 — 2026-10-21

- Accept unknown-size asset streams, measuring size and SHA-256 during reception while retaining expected-size/hash checks when supplied.
- Enforce asset and cumulative publication byte limits while streaming, with completed-asset recovery and known-size reservations.
- Add writer-only publication listing and volatile per-asset/total progress, keeping explicit commit and complete-only dataset discovery.
- Preserve compatibility with contract 0.1 records and existing known-size clients.

### 0.1.0 — 2026-10-21

- Add the `forecastDatasets` Resource Provider and an experimental documented HTTP contract.
- Add atomically committed multi-asset publications with immutable content hashes, restart recovery and asset-level resume.
- Serve original bytes with Range, HEAD, ETags and version-bound URLs.
- Add trusted inventory/index enrichment, strict verified-coverage/field discovery, v2 notifications and coordinated deletion.
- Keep indexing/decoding and subset processors independent; no processing operations are advertised in this catalogue release.
