# Sandbox verification

Target: the existing `signalk-sandbox` server, Signal K 2.34.0 / Node.js 24.21.0. The plugin's unit/HTTP tests also run locally on Node.js 20.19.2. Integration verification completed successfully on 2026-10-21.

## Deployment helpers

`tools/install-sandbox.cjs` is deliberately a first-install helper for this sandbox. It refuses to overwrite an installed plugin/configuration, backs up package manifests and pre-existing plugin configurations under the sandbox's `local-packages` directory, extracts the built archive and adds only this package to the root manifests. Existing dependency trees are not re-resolved. The installed server already supplies compatible Express 4 and server-api 2.34 packages.

The helper enables only Forecast Dataset Provider. A container restart loads the new plugin while preserving the existing image, mounts, overlays and other plugin configurations.

`tools/verify-sandbox.cjs` runs inside that explicitly selected sandbox. It uses a short-lived administrator JWT kept in memory, exercises HTTP on loopback, creates only synthetic test data and cleans up datasets/publications it created. It checks core Resources API discovery, original-content transport, incomplete publication, restart recovery, verified inventory, antimeridian filtering, anonymous-access denial and preservation of pre-existing plugin configurations.

Do not run these helpers against another installation without adapting their fixed paths and reviewing the deployment scope. They are not general production installers.

## Results

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
