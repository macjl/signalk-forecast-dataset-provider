// SPDX-License-Identifier: Apache-2.0
// Integration check for the user's explicitly selected, authenticated sandbox.
// Tokens remain in memory; only synthetic test datasets are deleted.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHmac, createHash } = require('node:crypto')
const { Readable } = require('node:stream')
assert.equal(process.env.SIGNALK_CONTAINER_ID, 'signalk-sandbox')
const root = process.env.SIGNALK_CONFIG_DIR
assert.ok(
  root && path.isAbsolute(root),
  'Set an absolute SIGNALK_CONFIG_DIR for the selected sandbox'
)
const plugin = 'signalk-forecast-dataset-provider'
const base = 'http://127.0.0.1:3000'
const api = `/plugins/${plugin}`
const security = JSON.parse(
  fs.readFileSync(path.join(root, 'security.json'), 'utf8')
)
const secret =
  security.secretKey ||
  fs.readFileSync(path.join(root, 'security-secret.key'), 'utf8').trim()
const admin = security.users.find((user) => user.type === 'admin')
assert.ok(admin, 'Sandbox must have an administrator')
const header = Buffer.from(
  JSON.stringify({ alg: 'HS256', typ: 'JWT' })
).toString('base64url')
const payload = Buffer.from(
  JSON.stringify({
    id: admin.username,
    exp: Math.floor(Date.now() / 1000) + 600
  })
).toString('base64url')
const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
const auth = { Authorization: `Bearer ${token}` }
const prefix = 'forecast-provider-sandbox-verification'
const publications = new Set(),
  datasets = new Set()
const call = (route, options = {}) => {
  const { json, headers = {}, ...rest } = options
  return fetch(base + route, {
    ...rest,
    headers: {
      ...auth,
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {})
  })
}
async function get(route) {
  const r = await call(route)
  assert.equal(r.status, 200, route)
  return r.json()
}
async function configure() {
  const config = await get(`${api}/config`)
  const r = await call(`${api}/config`, { method: 'POST', json: config })
  assert.equal(r.status, 200)
  for (let i = 0; i < 80; i++) {
    const response = await call(`${api}/status`)
    if (response.status === 200) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Plugin did not recover after configuration restart')
}
async function main() {
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
  const initial = await get('/signalk/v2/api/resources/forecastDatasets')
  const initialIds = Object.keys(initial).sort()
  const files = [
    Buffer.from([71, 82, 73, 66, 0, 255, 128, 7, 56, 56, 56, 56]),
    Buffer.from('Synthetic second forecast asset\n')
  ]
  let response = await call(`${api}/publications`, {
    method: 'POST',
    json: {
      kind: 'analysis',
      format: 'json',
      producer: prefix,
      metadata: { name: prefix, model: 'TEST' },
      assets: files.map((bytes, i) => ({
        id: `part-${i}`,
        ...(i
          ? {
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            }
          : {})
      }))
    }
  })
  assert.equal(response.status, 201)
  const stage = await response.json()
  publications.add(stage.id)
  assert.equal(stage.progress.totalBytes, null)
  assert.ok((await get(`${api}/publications`))[stage.id])
  const readonlyFile = path.join(
    configDir,
    'signalk-grib-weather-provider',
    'catalogue-token'
  )
  if (fs.existsSync(readonlyFile)) {
    const readonly = fs.readFileSync(readonlyFile, 'utf8').trim()
    const headers = { Authorization: `Bearer ${readonly}` }
    assert.equal((await call(`${api}/datasets`, { headers })).status, 200)
    assert.ok(
      [401, 403].includes(
        (await call(`${api}/publications`, { headers })).status
      )
    )
  }
  async function waitStage(predicate) {
    for (let i = 0; i < 100; i++) {
      const current = await get(`${api}/publications/${stage.id}`)
      if (predicate(current)) return current
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Publication progress did not reach expected state')
  }
  // Abort a real chunked request after the provider has accepted some bytes.
  let releaseBroken
  const brokenGate = new Promise((resolve) => {
    releaseBroken = resolve
  })
  const abort = new AbortController()
  const broken = call(`${api}/publications/${stage.id}/assets/part-0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Readable.from(
      (async function* () {
        yield files[0].subarray(0, 4)
        await brokenGate
      })()
    ),
    duplex: 'half',
    signal: abort.signal
  }).then(
    () => {
      throw new Error('Aborted upload unexpectedly completed')
    },
    () => {}
  )
  try {
    await waitStage(
      (p) => p.state === 'receiving' && p.progress.bytesReceived === 4
    )
  } finally {
    abort.abort()
    releaseBroken()
  }
  await broken
  await waitStage(
    (p) => p.state === 'pending' && p.progress.bytesReceived === 0
  )
  for (let i = 0; i < files.length; i++) {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const upload = call(`${api}/publications/${stage.id}/assets/part-${i}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: i
        ? files[i]
        : Readable.from(
            (async function* () {
              yield files[0].subarray(0, 4)
              await gate
              yield files[0].subarray(4)
            })()
          ),
      ...(i ? {} : { duplex: 'half' })
    })
    if (!i) {
      try {
        await waitStage(
          (p) => p.state === 'receiving' && p.progress.bytesReceived === 4
        )
      } finally {
        release()
      }
    }
    response = await upload
    assert.equal(response.status, 201)
    const measured = await response.json()
    assert.equal(measured.size, files[i].length)
    assert.equal(
      measured.sha256,
      createHash('sha256').update(files[i]).digest('hex')
    )
    if (i === 0) {
      assert.equal(
        Object.keys(await get('/signalk/v2/api/resources/forecastDatasets'))
          .length,
        initialIds.length
      )
      assert.equal(
        (
          await call(`${api}/publications/${stage.id}/commit`, {
            method: 'POST'
          })
        ).status,
        409
      )
      await configure()
      assert.equal(
        (await get(`${api}/publications/${stage.id}`)).uploaded['part-0'].size,
        files[0].length
      )
    }
  }
  assert.equal((await get(`${api}/publications/${stage.id}`)).state, 'ready')
  response = await call(`${api}/publications/${stage.id}/commit`, {
    method: 'POST'
  })
  assert.equal(response.status, 201)
  const record = await response.json()
  datasets.add(record.id)
  publications.delete(stage.id)
  console.log(
    'PASS: Signal K 2.34 unknown-size chunked streaming, live progress, aborted upload cleanup/retry, mixed-size publication and recovery after plugin restart'
  )
  const listed = await get(
    '/signalk/v2/api/resources/forecastDatasets?model=TEST'
  )
  assert.ok(listed[record.id])
  assert.equal(listed[record.id].assetCount, 2)
  const viaCore = await get(
    `/signalk/v2/api/resources/forecastDatasets/${record.id}`
  )
  assert.equal(viaCore.version, record.version)
  const asset = viaCore.assets[0].href
  response = await call(asset, {
    headers: { Range: 'bytes=4-8', 'Accept-Encoding': 'gzip' }
  })
  assert.equal(response.status, 206)
  assert.equal(
    response.headers.get('content-range'),
    `bytes 4-8/${files[0].length}`
  )
  assert.equal(response.headers.get('content-encoding'), null)
  const originalEtag = response.headers.get('etag')
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    files[0].subarray(4, 9)
  )
  response = await call(asset, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(Number(response.headers.get('content-length')), files[0].length)
  response = await call(asset, { headers: { 'If-None-Match': originalEtag } })
  assert.equal(response.status, 304)
  response = await call(asset)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), files[0])
  console.log(
    'PASS: core Resource API discovery/detail, original bytes, Range, HEAD, ETag and no transparent encoding'
  )
  const detail = `${api}/datasets/${record.id}/versions/${record.version}`
  response = await call(detail)
  const before = response.headers.get('etag')
  response = await call(`${detail}/inventory`, {
    method: 'PUT',
    headers: { 'If-Match': before },
    json: {
      metadata: {
        model: 'TEST',
        bounds: [170, -10, -170, 20],
        forecast: { from: '2026-10-21T00:00:00Z', to: '2026-10-23T00:00:00Z' },
        fields: [{ parameter: 'eastward_wind' }]
      },
      index: {
        messages: [
          {
            assetId: 'part-0',
            offset: 0,
            length: files[0].length,
            parameter: 'eastward_wind'
          }
        ]
      }
    }
  })
  assert.equal(response.status, 200)
  assert.notEqual(response.headers.get('etag'), before)
  assert.equal(
    (await call(asset, { method: 'HEAD' })).headers.get('etag'),
    originalEtag
  )
  const indexed = await get(`${detail}/index`)
  assert.equal(indexed.version, record.version)
  assert.equal(indexed.index.messages.length, 1)
  assert.ok(
    (
      await get(
        '/signalk/v2/api/resources/forecastDatasets?bbox=175,0,-175,10&verified=true'
      )
    )[record.id]
  )
  console.log(
    'PASS: trusted inventory enrichment, index/content binding and verified antimeridian discovery'
  )
  await configure()
  assert.equal(
    (await get(`/signalk/v2/api/resources/forecastDatasets/${record.id}`))
      .version,
    record.version
  )
  response = await fetch(base + asset)
  assert.ok(
    [401, 403].includes(response.status),
    `Anonymous content returned ${response.status}`
  )
  response = await fetch(base + api + '/publications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.ok([401, 403].includes(response.status))
  assert.deepEqual((await get(`${api}/status`)).operations, [])
  console.log(
    'PASS: persisted dataset/index after plugin restart, anonymous access denied, no unimplemented subset capability advertised'
  )
  response = await call(`${api}/datasets/${record.id}`, { method: 'DELETE' })
  assert.equal(response.status, 204)
  datasets.delete(record.id)
  assert.equal((await call(asset)).status, 404)
  assert.deepEqual(
    Object.keys(await get('/signalk/v2/api/resources/forecastDatasets')).sort(),
    initialIds
  )
  {
    for (const [file, config] of Object.entries(configs))
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(root, 'plugin-config-data', file), 'utf8')
        ),
        config,
        `Pre-existing plugin config changed: ${file}`
      )
    console.log(
      `PASS: deletion and test-data cleanup; ${Object.keys(configs).length} pre-existing plugin configurations preserved`
    )
  }
}
main()
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    for (const id of publications)
      await call(`${api}/publications/${id}`, { method: 'DELETE' }).catch(
        () => {}
      )
    for (const id of datasets)
      await call(`${api}/datasets/${id}`, { method: 'DELETE' }).catch(() => {})
  })
