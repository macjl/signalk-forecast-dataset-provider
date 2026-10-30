# npm publishing

This follows the recent `macjl` Signal K plugin workflows (GRIB Weather Provider,
GRIB Downloader and History Explorer): publish a GitHub Release, or manually run
`.github/workflows/publish.yml`. Publication uses npm trusted publishing (OIDC)
with provenance; no `NPM_TOKEN` GitHub secret is used.

The package and trusted publisher already exist. Release **0.1.0** is the first
stable version and publishes to `latest`; the earlier public release was
`0.1.0-beta.1`. Older 0.1.0/0.1.1/0.1.2 entries were unpublished development
snapshots. See [the coordinated upgrade guide](docs/upgrading.md).

## First publication setup

The package must exist before an npm trusted publisher can be configured. The
existing `0.0.0-stage` bootstrap already satisfies this: **do not repeat the
bootstrap for this package**. For a new package, as with History Explorer,
bootstrap an **empty** placeholder outside its checkout.
These commands publish publicly and must be run deliberately by the maintainer:

```sh
npm login --registry=https://registry.npmjs.org
test "$(npm whoami --registry=https://registry.npmjs.org)" = macjl
forecast_bootstrap_dir="$(mktemp -d)"
cd "$forecast_bootstrap_dir"
npm init -y
npm pkg set name=signalk-forecast-dataset-provider version=0.0.1 \
  description="Empty bootstrap package for Signal K Forecast Dataset Provider" \
  license=Apache-2.0 \
  repository.type=git \
  repository.url=git+https://github.com/macjl/signalk-forecast-dataset-provider.git
npm pack --dry-run
npm publish --registry=https://registry.npmjs.org --access public --tag bootstrap
```

Do not add the Signal K plugin keyword to this placeholder or publish it from
the real checkout. The bootstrap tag does not make the placeholder functional;
npm may initially also assign `latest` to it. A later stable release updates
`latest`; a beta release only updates `beta`.

After bootstrap, with npm CLI 11.15.0+ and account 2FA enabled, configure:

```sh
npm trust github signalk-forecast-dataset-provider \
  --repo macjl/signalk-forecast-dataset-provider \
  --file publish.yml \
  --allow-publish \
  --registry=https://registry.npmjs.org
npm trust list signalk-forecast-dataset-provider --registry=https://registry.npmjs.org
```

Alternatively use npm package Settings → Trusted publishing. Set owner `macjl`,
repository `signalk-forecast-dataset-provider`, workflow filename `publish.yml`
(not its path), leave environment empty, and allow direct `npm publish`.
The workflow file must be pushed to GitHub first. Configure this when ready:
a new trusted publisher must successfully publish within two days or be recreated.
See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Prepare the real plugin version

The first stable version is **0.1.0**. Decide the new version before tagging
subsequent releases.
Keep `package.json`, `package-lock.json`, the OpenAPI info version and changelog
consistent if changing it. The resource contract stays `0.1` independently of
the npm package version.

```sh
npm ci
npm run check
npm pack --dry-run
```

The archive must contain `dist/index.js`, every other runtime JS module and type
declaration, icon, license and documentation. Source-only tests, deployment
helpers, local configuration and credentials must not be included. Compilation
runs during `prepack`, so the installed App Store package needs no install/build
script. `prepublishOnly` reruns the full checks before a real publish.

The local CI checks Node 20/22/24. The separate Signal K reusable CI follows the
other plugins and adds Linux/ARM64/macOS/Windows plus real-server integration.
Those hosted checks only run after pushing; local success does not claim they
have already passed. Publication uses Node 24 on a GitHub-hosted runner.

## Publish only when approved

Commit and push the reviewed release content, create the matching `vX.Y.Z` tag,
and publish a GitHub Release from that tag. Publishing that Release starts npm
publication. A plain code push does not. Manual workflow dispatch also publishes
the version checked out, so do not use it as a dry run.

The workflow verifies/tests the checkout, checks archive contents, rejects a
release tag/version mismatch and skips a version already present on npm.
Prerelease versions use `alpha`, `beta`, `rc` or `next`; stable versions use
`latest`. A GitHub prerelease with a stable package version is rejected.

Confirm the workflow succeeds, then inspect npm version, files, dist-tag and
provenance. The OIDC path cannot be fully validated by a local dry run: npm must
recognise the configured GitHub workflow. Tighten npm publishing access only
after that first successful OIDC publication, as in the other plugins.

## Preparation checks (2026-10-21)

The 27 local tests, formatting and TypeScript checks passed. `npm publish --dry-run`
completed without publishing; the inspected archive contains 24 files, including
the compiled runtime and release guide, excluding source tests/deployment helpers.
The archive also installed in an isolated temporary directory with lifecycle
scripts disabled, and its compiled plugin/schema loaded successfully.

Workflow YAML and shell syntax were checked locally. With `npm` replaced by a
test function, stable/alpha/beta/rc/next routing, release-tag mismatch rejection
and protection against publishing a GitHub prerelease as `latest` passed. These
checks are not an authenticated OIDC publish or a hosted GitHub CI run. No code
push, tag, release, registry write or npm trust change was performed.
