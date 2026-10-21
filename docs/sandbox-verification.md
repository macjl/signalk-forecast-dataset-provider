# Sandbox verification

Target: the existing `signalk-sandbox` server, Signal K 2.34.0 / Node.js 24.21.0. The plugin's unit/HTTP tests also run locally on Node.js 20.19.2. Integration verification completed successfully on 2026-10-21.

## Deployment helpers

`tools/install-sandbox.cjs` is deliberately a first-install helper for this sandbox. It refuses to overwrite an installed plugin/configuration, backs up package manifests and pre-existing plugin configurations under the sandbox's `local-packages` directory, extracts the built archive and adds only this package to the root manifests. Existing dependency trees are not re-resolved. The installed server already supplies compatible Express 4 and server-api 2.34 packages.

The helper enables only Forecast Dataset Provider. A container restart loads the new plugin while preserving the existing image, mounts, overlays and other plugin configurations.

`tools/verify-sandbox.cjs` runs inside that explicitly selected sandbox. It uses a short-lived administrator JWT kept in memory, exercises HTTP on loopback, creates only synthetic test data and cleans up datasets/publications it created. It checks core Resources API discovery, original-content transport, incomplete publication, restart recovery, verified inventory, antimeridian filtering, anonymous-access denial and preservation of pre-existing plugin configurations.

Do not run these helpers against another installation without adapting their fixed paths and reviewing the deployment scope. They are not general production installers.

The helpers require `SIGNALK_CONTAINER_ID=signalk-sandbox` and an explicitly supplied absolute `SIGNALK_CONFIG_DIR` (the selected container's configuration directory). They do not infer a hardcoded home directory. Pass it through `docker exec -e SIGNALK_CONFIG_DIR=<absolute-config-directory> ...` when invoking a helper.

## Results — initial version 0.1.0

The first-install helper deployed version 0.1.0 and enabled the plugin. The existing container image, mounts and overlays were preserved; existing packages were not re-resolved. Pre-install manifests and plugin configurations were backed up inside the sandbox under `local-packages/forecast-provider-before-install-2026-10-21T09-35-20-214Z`.

The integration helper passed all of these checks against the running server:

- Two-asset staged publication; an incomplete commit returns 409 and remains absent from discovery.
- Plugin configuration restart during staging; the completed first asset survives and publication can finish without re-uploading it.
- Discovery and detail through the real `/signalk/v2/api/resources/forecastDatasets` endpoints.
- Byte-for-byte original content, single-range 206 responses, HEAD metadata, ETag revalidation and no transparent content encoding.
- Admin inventory enrichment with a metadata revision, index/content-version binding and strict verified antimeridian discovery.
- Persistence of published content and inventory after another plugin restart.
- Anonymous content and publication requests are denied; no unimplemented processor capabilities are advertised.
- Deletion and cleanup of the test datasets/publications; all 44 pre-existing plugin configuration files remain unchanged.

The plugin remains installed and enabled, with no synthetic test datasets left in its catalogue.

## Verification limits

The live authenticated checks used an administrator, with separate anonymous rejection checks. Readonly/readwrite/admin route declarations are exercised by the local HTTP adapter, not by creating or modifying sandbox user accounts. Inspection of Signal K 2.34's security layer revealed an important limitation: it matches permission entries by exact method and its scoped router cannot register HEAD. Consequently HEAD requires admin on that version, whereas GET/Range routes are declared readonly. The local adapter reflects this limitation. No server security code was changed.

The local suite contains 20 passing storage, HTTP/lifecycle and OpenAPI tests. Notification payloads and their v2 target are asserted locally; live WebSocket delivery was not part of this integration run. Synthetic binary fixtures validate storage and transport, not GRIB decoding or the integration of a real downloader/indexer. Subsetting and processor dispatch are not implemented or claimed by this version.

## Streaming update 0.1.1 — 2026-10-21

Provider and Browser 0.1.1 were installed in the same existing sandbox without dependency re-resolution, image replacement or catalogue migration. `tools/update-sandbox.cjs` backs up the previous provider package and root manifests and preserves configurations/catalogue content. The provider backup is `local-packages/forecast-provider-before-update-2026-10-21T15-44-17-583Z`. The original first-install helper remains first-install-only.

The updated provider integration helper passed unknown-size chunked upload with live progress; interruption after accepted bytes followed by partial-file cleanup and retry; a mixed known/unknown-size publication; incomplete-commit rejection; recovery after plugin restart; measured size/hash verification; original Range/HEAD/ETag access; inventory enrichment and strict verified discovery. A pre-existing readonly credential was checked successfully against dataset reads and denied staging listing (Signal K may return 401 for insufficient access). No user account or security setting was changed.

The actual Browser UI passed acquisition display during streaming, indeterminate progress for unknown total, ready-but-unpublished display, and automatic catalogue refresh after explicit commit. Administrator and readonly sessions, desktop/mobile layout, cancellation and deletion were exercised. The 2 pre-existing datasets remained present, with all 46 plugin configurations and 43 unrelated dependencies preserved. Synthetic fixtures used JSON/analysis, avoiding the live GRIB Weather Provider's forecast discovery; all test publications/datasets were removed.

Local verification: 25 provider tests, 12 browser-client tests and 12 Playwright UI tests pass. The host's already extracted Chromium libraries were reused via `LD_LIBRARY_PATH=/tmp/forecast-browser-libs/root/usr/lib/aarch64-linux-gnu`; no system packages were installed. Limits, expected size/hash mismatch, empty uploads and interrupted/recovered content are covered locally. Tests demonstrate direct HTTP streaming into the provider, not a production downloader refactor; existing downloaders remain unchanged.

Update/rollback note: committed contract 0.1 datasets retain the same storage and content identity. Before downgrading to 0.1.0, finish or explicitly abort unknown-size staging publications: that older version requires a declared size and cannot load these unfinished manifests. Do not restore catalogue content from the package backup or delete unrelated data to roll back code.

## Size configuration 0.1.2 — 2026-10-21

Plugin Config now exposes `maxAssetMiB: 2048` and `maxDatasetMiB: 8192`, with explicit MiB labels (1,048,576 bytes). Effective default byte limits and byte-based HTTP/index/progress semantics are unchanged. No configuration migration or compatibility aliases are included for the unpublished prototype. Only this sandbox plugin's settings were manually adjusted through its configuration API.

The updated 0.1.2 archive was installed with a backup at `local-packages/forecast-provider-before-update-2026-10-21T18-45-50-384Z`. The actual `/plugins` schema and saved settings were verified. The 45 other plugin configurations, enable/debug flags and both existing dataset content versions remained unchanged. The provider's streaming/recovery/transport integration helper passed again and removed its synthetic data. Local checks pass 27 tests, including unit conversion, invalid configuration and enforcement of a MiB-configured limit during an upload.
