// SPDX-License-Identifier: Apache-2.0
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { Readable } = require('node:stream')
const { createHash } = require('node:crypto')
const express =
  process.env.FORECAST_TEST_EXPRESS === '4'
    ? require('express4')
    : require('express')
const createPlugin = require('../dist')
const { PLUGIN_ID, API_ROOT, RESOURCE_TYPE } = require('../dist/types')
const { byteRange } = require('../dist/http')
const { BYTES_PER_MIB } = require('../dist/settings')

// This adapter enforces the access declarations that Signal K normally applies.
// It is not a replacement for testing against an actual Signal K instance.
function securedRouter() {
  const router = express.Router()
  const raw = Object.fromEntries(
    ['get', 'post', 'put', 'delete'].map((method) => [
      method,
      router[method].bind(router)
    ])
  )
  const allow = (required) => (req, res, next) => {
    const role = req.get('X-Test-Role')
    if (!role) return res.status(401).end()
    // Signal K 2.34 matches access declarations by exact HTTP method.
    // Its scoped router exposes GET, but not HEAD, so HEAD defaults to admin.
    if (req.method === 'HEAD' && role !== 'admin') return res.status(403).end()
    if (
      (required === 'admin' && role !== 'admin') ||
      (required === 'readwrite' && role === 'readonly')
    )
      return res.status(403).end()
    next()
  }
  for (const method of Object.keys(raw))
    router[method] = (route, ...handlers) =>
      raw[method](route, allow('admin'), ...handlers)
  router.access = (level) => {
    const registrar = {}
    for (const method of Object.keys(raw))
      registrar[method] = (route, ...handlers) => {
        raw[method](route, allow(level), ...handlers)
        return registrar
      }
    return registrar
  }
  return router
}

async function fixture(t, configuration = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forecast-http-'))
  const deltas = [],
    errors = [],
    statuses = []
  let provider
  const app = {
    getDataDirPath: () => root,
    registerResourceProvider: (p) => {
      provider = p
    },
    handleMessage: (...args) => deltas.push(args),
    setPluginStatus: (msg) => statuses.push(msg),
    setPluginError: (msg) => errors.push(msg),
    error: (msg) => errors.push(msg)
  }
  const plugin = createPlugin(app)
  await plugin.start(configuration)
  assert.equal(errors.length, 0, errors.join('\n'))
  const serverApp = express()
  const router = securedRouter()
  plugin.registerWithRouter(router)
  serverApp.use(API_ROOT, router)
  const server = serverApp.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}${API_ROOT}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await plugin.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
  const call = (route, options = {}) => {
    const { role = 'admin', json, headers = {}, ...rest } = options
    return fetch(base + route, {
      ...rest,
      headers: {
        ...(role ? { 'X-Test-Role': role } : {}),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {})
    })
  }
  return {
    plugin,
    call,
    deltas,
    errors,
    statuses,
    get provider() {
      return provider
    }
  }
}
const content = Buffer.from([71, 82, 73, 66, 0, 255, 128, 42, 13, 10])
async function publication(f) {
  const response = await f.call('/publications', {
    method: 'POST',
    json: {
      kind: 'forecast',
      format: 'grib2',
      producer: 'external-http-client',
      assets: [{ id: 'forecast', size: content.length }]
    }
  })
  assert.equal(response.status, 201)
  const p = await response.json()
  const uploaded = await f.call(`/publications/${p.id}/assets/forecast`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content
  })
  assert.equal(uploaded.status, 201)
  const committed = await f.call(`/publications/${p.id}/commit`, {
    method: 'POST'
  })
  assert.equal(committed.status, 201)
  const record = await committed.json()
  return { p, record, asset: record.assets[0].href.slice(API_ROOT.length) }
}

test('external client publishes, discovers and downloads binary content without filesystem paths', async (t) => {
  const f = await fixture(t)
  const { record, asset } = await publication(f)
  assert.equal(f.provider.type, RESOURCE_TYPE)
  const list = await f.provider.methods.listResources({ format: 'grib2' })
  assert.equal(list[record.id].assetCount, 1)
  assert.equal(list[record.id].assets, undefined)
  const response = await f.call(asset, {
    role: 'readonly',
    headers: { 'Accept-Encoding': 'gzip' }
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
  assert.equal((await f.call('/datasets')).status, 200)
  assert.equal(
    (await f.provider.methods.getResource(record.id)).inventory.status,
    'unverified'
  )
  assert.equal(
    (await f.provider.methods.getResource(record.id, 'assets.0.size')).value,
    content.length
  )
  await assert.rejects(
    f.provider.methods.getResource(record.id, '__proto__.polluted'),
    (e) => e.status === 404
  )
  await assert.rejects(
    f.provider.methods.setResource(record.id, {}),
    (e) => e.code === 'PUBLICATION_REQUIRED'
  )
  const delta = f.deltas[0]
  assert.equal(delta[0], PLUGIN_ID)
  assert.equal(delta[2], 'v2')
  assert.equal(
    delta[1].updates[0].values[0].path,
    `resources.forecastDatasets.${record.id}`
  )
})

test('writer lists live unknown-size uploads; readers cannot inspect staging and commit stays explicit', async (t) => {
  const f = await fixture(t)
  let response = await f.call('/publications', {
    method: 'POST',
    role: 'readwrite',
    json: {
      kind: 'forecast',
      format: 'grib2',
      producer: 'streaming-client',
      assets: [{ id: 'forecast' }]
    }
  })
  assert.equal(response.status, 201)
  const publication = await response.json()
  assert.equal(publication.progress.totalBytes, null)
  assert.equal(
    (await f.call('/publications', { role: 'readonly' })).status,
    403
  )
  assert.equal((await f.call('/publications', { role: null })).status, 401)
  assert.equal(
    (await f.call(`/publications/${publication.id}`, { role: 'readonly' }))
      .status,
    403
  )
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release())
  const body = Readable.from(
    (async function* () {
      yield content.subarray(0, 4)
      await gate
      yield content.subarray(4)
    })()
  )
  const uploading = f.call(`/publications/${publication.id}/assets/forecast`, {
    method: 'PUT',
    role: 'readwrite',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    duplex: 'half'
  })
  let status
  for (let i = 0; i < 100; i++) {
    response = await f.call('/publications', { role: 'readwrite' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    status = (await response.json())[publication.id]
    if (status.progress.bytesReceived === 4) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(status.state, 'receiving')
  assert.equal(status.progress.bytesReceived, 4)
  assert.deepEqual(await (await f.call('/datasets')).json(), {})
  release()
  response = await uploading
  assert.equal(response.status, 201)
  const measured = await response.json()
  assert.equal(measured.size, content.length)
  assert.equal(
    measured.sha256,
    createHash('sha256').update(content).digest('hex')
  )
  assert.equal(
    (await (await f.call(`/publications/${publication.id}`)).json()).state,
    'ready'
  )
  assert.deepEqual(await (await f.call('/datasets')).json(), {})
  response = await f.call(`/publications/${publication.id}/commit`, {
    method: 'POST'
  })
  assert.equal(response.status, 201)
  const record = await response.json()
  assert.deepEqual(
    Buffer.from(
      await (
        await f.call(record.assets[0].href.slice(API_ROOT.length))
      ).arrayBuffer()
    ),
    content
  )
  assert.deepEqual(await (await f.call('/publications')).json(), {})
})

test('unknown declaration accepts Content-Length but never bypasses configured limits', async (t) => {
  const f = await fixture(t, { maxAssetMiB: 5 / BYTES_PER_MIB })
  const response = await f.call('/publications', {
    method: 'POST',
    json: {
      kind: 'forecast',
      format: 'grib2',
      producer: 'client',
      assets: [{ id: 'a' }]
    }
  })
  const p = await response.json()
  assert.equal(
    (
      await f.call(`/publications/${p.id}/assets/a`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content
      })
    ).status,
    413
  )
  const uploaded = await f.call(`/publications/${p.id}/assets/a`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: 'abc'
  })
  assert.equal(uploaded.status, 201)
  assert.equal((await uploaded.json()).size, 3)
})

test('Range, suffix/open ranges, HEAD and conditional validators refer to exact original bytes', async (t) => {
  const f = await fixture(t)
  const { asset } = await publication(f)
  let response = await f.call(asset, { headers: { Range: 'bytes=4-7' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 4-7/10')
  assert.equal(response.headers.get('content-length'), '4')
  const tag = response.headers.get('etag')
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    content.subarray(4, 8)
  )
  response = await f.call(asset, { headers: { Range: 'bytes=-3' } })
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    content.subarray(7)
  )
  response = await f.call(asset, { headers: { Range: 'bytes=7-' } })
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    content.subarray(7)
  )
  response = await f.call(asset, { headers: { Range: 'bytes=4-99' } })
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    content.subarray(4)
  )
  response = await f.call(asset, { method: 'HEAD', role: 'readonly' })
  assert.equal(response.status, 403)
  response = await f.call(asset, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), '10')
  assert.equal((await response.arrayBuffer()).byteLength, 0)
  response = await f.call(asset, { headers: { 'If-None-Match': `W/${tag}` } })
  assert.equal(response.status, 304)
  response = await f.call(asset, {
    headers: { Range: 'bytes=0-2', 'If-Range': '"another-version"' }
  })
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
  for (const range of [
    'bytes=99-',
    'bytes=-0',
    'bytes=0-1,4-5',
    'bytes=5-4',
    'not-bytes'
  ]) {
    response = await f.call(asset, { headers: { Range: range } })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), 'bytes */10')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.notEqual(response.headers.get('etag'), tag)
    assert.equal((await response.json()).code, 'INVALID_RANGE')
  }
})

test('indexer enrichment uses metadata ETags and leaves binary ETag unchanged', async (t) => {
  const f = await fixture(t)
  const { record, asset } = await publication(f)
  const prefix = `/datasets/${record.id}/versions/${record.version}`
  let response = await f.call(prefix)
  const tag = response.headers.get('etag')
  const binaryTag = (await f.call(asset, { method: 'HEAD' })).headers.get(
    'etag'
  )
  const body = {
    metadata: { model: 'GFS', fields: [{ parameter: 'eastward_wind' }] },
    index: { messages: [{ assetId: 'forecast', offset: 0, length: 10 }] }
  }
  response = await f.call(`${prefix}/inventory`, { method: 'PUT', json: body })
  assert.equal(response.status, 428)
  response = await f.call(`${prefix}/inventory`, {
    method: 'PUT',
    json: body,
    headers: { 'If-Match': tag }
  })
  assert.equal(response.status, 200)
  assert.notEqual(response.headers.get('etag'), tag)
  assert.equal((await response.json()).version, record.version)
  assert.equal(
    (await f.call(asset, { method: 'HEAD' })).headers.get('etag'),
    binaryTag
  )
  response = await f.call(`${prefix}/inventory`, {
    method: 'PUT',
    json: body,
    headers: { 'If-Match': tag }
  })
  assert.equal(response.status, 412)
  response = await f.call(`${prefix}/index`)
  const index = await response.json()
  assert.equal(index.version, record.version)
  assert.equal(index.assets[0].size, 10)
  assert.equal(index.index.messages[0].assetId, 'forecast')
})

test('declared route permissions protect publication and indexer writes', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call('/status', { role: null })).status, 401)
  assert.equal((await f.call('/status', { role: 'readonly' })).status, 200)
  assert.equal(
    (
      await f.call('/publications', {
        method: 'POST',
        role: 'readonly',
        json: {}
      })
    ).status,
    403
  )
  const { record, asset } = await publication(f)
  assert.equal((await f.call(asset, { role: 'readwrite' })).status, 200)
  assert.equal(
    (
      await f.call(`/datasets/${record.id}`, {
        method: 'DELETE',
        role: 'readonly'
      })
    ).status,
    403
  )
  assert.equal(
    (
      await f.call(
        `/datasets/${record.id}/versions/${record.version}/inventory`,
        { method: 'PUT', role: 'readwrite', json: {} }
      )
    ).status,
    403
  )
})

test('deletion emits a null v2 resource delta and removes original content', async (t) => {
  const f = await fixture(t)
  const { record, asset } = await publication(f)
  assert.equal(
    (await f.call(`/datasets/${record.id}`, { method: 'DELETE' })).status,
    204
  )
  assert.equal((await f.call(asset)).status, 404)
  assert.equal(f.deltas.at(-1)[1].updates[0].values[0].value, null)
})

test('invalid queries and JSON fail explicitly and unsupported processing is not advertised', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call('/datasets?unknown=1')).status, 400)
  const response = await f.call('/publications', {
    method: 'POST',
    body: '{',
    headers: { 'Content-Type': 'application/json' }
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'INVALID_JSON')
  assert.deepEqual((await (await f.call('/status')).json()).operations, [])
  await f.plugin.stop()
  assert.equal((await f.call('/datasets')).status, 503)
})

test('byte range parser handles large suffixes and rejects unsafe integers', () => {
  assert.deepEqual(byteRange('bytes=-1000', 10), { start: 0, end: 9 })
  assert.throws(
    () => byteRange('bytes=999999999999999999999999-', 10),
    (e) => e.status === 416
  )
})
