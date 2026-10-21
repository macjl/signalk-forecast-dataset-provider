// SPDX-License-Identifier: Apache-2.0
// Targeted update only: no dependency resolution, configuration or catalogue writes.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
assert.equal(process.env.SIGNALK_CONTAINER_ID, 'signalk-sandbox')
const root = process.env.SIGNALK_CONFIG_DIR
assert.ok(
  root && path.isAbsolute(root),
  'Set an absolute SIGNALK_CONFIG_DIR for the selected sandbox'
)
const name = 'signalk-forecast-dataset-provider'
const archive = process.argv[2]
assert.ok(archive && path.isAbsolute(archive) && fs.existsSync(archive))
const relative = path.relative(root, fs.realpathSync(archive))
assert.ok(relative.startsWith('local-packages/') && !relative.includes('..'))
const destination = path.join(root, 'node_modules', name)
assert.equal(
  JSON.parse(fs.readFileSync(path.join(destination, 'package.json'))).name,
  name
)
assert.ok(fs.existsSync(path.join(root, 'plugin-config-data', name + '.json')))
const pkg = JSON.parse(
  execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
    encoding: 'utf8'
  })
)
assert.equal(pkg.name, name)
assert.equal(pkg.version, '0.1.0-beta.1')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(
  root,
  'local-packages',
  `forecast-provider-before-update-${stamp}`
)
fs.mkdirSync(backup, { mode: 0o700 })
for (const file of [
  'package.json',
  'package-lock.json',
  'node_modules/.package-lock.json'
])
  if (fs.existsSync(path.join(root, file)))
    fs.copyFileSync(
      path.join(root, file),
      path.join(backup, file.replaceAll('/', '-'))
    )
const configDir = path.join(root, 'plugin-config-data')
const hashes = Object.fromEntries(
  fs
    .readdirSync(configDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [
      file,
      createHash('sha256')
        .update(fs.readFileSync(path.join(configDir, file)))
        .digest('hex')
    ])
)
fs.writeFileSync(
  path.join(backup, 'configuration-hashes.json'),
  JSON.stringify(hashes)
)
execFileSync('tar', [
  '-czf',
  path.join(backup, 'previous-plugin.tgz'),
  '-C',
  destination,
  '.'
])
const staging = path.join(
  root,
  'node_modules',
  `.forecast-provider-update-${stamp}`
)
fs.mkdirSync(staging)
execFileSync('tar', [
  '-xzf',
  archive,
  '--strip-components=1',
  '--no-same-owner',
  '-C',
  staging
])
assert.equal(
  require(
    require.resolve('express/package.json', { paths: [staging] })
  ).version.split('.')[0],
  '4'
)
execFileSync('chown', ['-R', 'node:node', staging])
const previous = path.join(
  root,
  'node_modules',
  `.forecast-provider-previous-${stamp}`
)
fs.renameSync(destination, previous)
fs.renameSync(staging, destination)
const atomic = (file, value) => {
  const stat = fs.statSync(file)
  const tmp = file + '.forecast-update.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
    mode: stat.mode & 0o777
  })
  fs.chownSync(tmp, stat.uid, stat.gid)
  fs.renameSync(tmp, file)
}
const packagePath = path.join(root, 'package.json')
const packages = JSON.parse(fs.readFileSync(packagePath))
packages.dependencies[name] = `file:${relative}`
atomic(packagePath, packages)
const entry = {
  version: pkg.version,
  resolved: `file:${relative}`,
  integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`,
  license: pkg.license,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  peerDependencies: pkg.peerDependencies
}
for (const file of ['package-lock.json', 'node_modules/.package-lock.json']) {
  const location = path.join(root, file)
  if (!fs.existsSync(location)) continue
  const lock = JSON.parse(fs.readFileSync(location))
  lock.packages[`node_modules/${name}`] = entry
  if (lock.packages[''])
    lock.packages[''].dependencies[name] = `file:${relative}`
  atomic(location, lock)
}
for (const [file, hash] of Object.entries(hashes))
  assert.equal(
    createHash('sha256')
      .update(fs.readFileSync(path.join(configDir, file)))
      .digest('hex'),
    hash
  )
// Only the just-replaced package directory; its recoverable archive is in backup.
fs.rmSync(previous, { recursive: true })
console.log(
  `Updated ${name} ${pkg.version}; ${Object.keys(hashes).length} configurations preserved. Backup: ${backup}`
)
