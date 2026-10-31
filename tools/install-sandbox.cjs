// SPDX-License-Identifier: Apache-2.0
// Run inside the explicitly selected Signal K sandbox container, as root.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const assert = require('node:assert/strict')

assert.equal(process.env.SIGNALK_CONTAINER_ID, 'signalk-sandbox')
const root = process.env.SIGNALK_CONFIG_DIR
assert.ok(
  root && path.isAbsolute(root),
  'Set an absolute SIGNALK_CONFIG_DIR for the selected sandbox'
)
const name = 'signalk-forecast-dataset-provider'
const archive = process.argv[2]
assert.ok(
  archive && path.isAbsolute(archive),
  'Supply the absolute sandbox tarball path'
)
assert.ok(
  fs.existsSync(archive),
  'Archive must exist before any installation changes'
)
const relative = path.relative(root, archive)
assert.ok(
  relative.startsWith('local-packages/') && !relative.includes('..'),
  'Archive must be in the sandbox local-packages directory'
)
const destination = path.join(root, 'node_modules', name)
assert.ok(
  !fs.existsSync(destination),
  'First-install helper refuses to overwrite an installed plugin'
)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(
  root,
  'local-packages',
  `forecast-provider-before-install-${stamp}`
)
fs.mkdirSync(backup, { recursive: true })
const atomic = (file, value) => {
  const tmp = `${file}.forecast-install.tmp`
  const previous = fs.existsSync(file) ? fs.statSync(file) : undefined
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
    mode: previous ? previous.mode & 0o777 : 0o600
  })
  if (previous) fs.chownSync(tmp, previous.uid, previous.gid)
  fs.renameSync(tmp, file)
}
const packagePath = path.join(root, 'package.json')
fs.copyFileSync(packagePath, path.join(backup, 'package.json'))
const configDir = path.join(root, 'plugin-config-data')
const configs = Object.fromEntries(
  fs
    .readdirSync(configDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [
      file,
      JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8'))
    ])
)
atomic(path.join(backup, 'plugin-configs.json'), configs)
fs.mkdirSync(destination)
execFileSync('tar', [
  '-xzf',
  archive,
  '--no-same-owner',
  '--strip-components=1',
  '-C',
  destination
])
const installed = JSON.parse(
  fs.readFileSync(path.join(destination, 'package.json'), 'utf8')
)
assert.equal(installed.name, name)
assert.ok(
  require(
    require.resolve('express/package.json', { paths: [destination] })
  ).version.startsWith('5.')
)
execFileSync('chown', ['-R', 'node:node', destination])
const packages = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
packages.dependencies ??= {}
packages.dependencies[name] = `file:${relative}`
atomic(packagePath, packages)
const entry = {
  version: installed.version,
  resolved: `file:${relative}`,
  integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`,
  license: installed.license,
  engines: installed.engines,
  dependencies: installed.dependencies,
  peerDependencies: installed.peerDependencies
}
for (const file of ['package-lock.json', 'node_modules/.package-lock.json']) {
  const location = path.join(root, file)
  if (!fs.existsSync(location)) continue
  fs.copyFileSync(
    location,
    path.join(
      backup,
      path.basename(file) === '.package-lock.json'
        ? 'hidden-package-lock.json'
        : file
    )
  )
  const lock = JSON.parse(fs.readFileSync(location, 'utf8'))
  lock.packages[`node_modules/${name}`] = entry
  if (lock.packages['']) {
    lock.packages[''].dependencies ??= {}
    lock.packages[''].dependencies[name] = `file:${relative}`
  }
  atomic(location, lock)
}
const config = path.join(configDir, `${name}.json`)
assert.ok(
  !fs.existsSync(config),
  'Existing plugin configuration must be preserved explicitly'
)
atomic(config, {
  enabled: true,
  enableDebug: false,
  enableLogging: false,
  configuration: {}
})
execFileSync('chown', ['node:node', packagePath, config])
atomic(
  path.join(root, 'local-packages', 'forecast-provider-install-backup.json'),
  { backup }
)
console.log(
  `Installed ${name} ${installed.version}; existing packages were not re-resolved. Backup: ${backup}`
)
