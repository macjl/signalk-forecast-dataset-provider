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
    req.skIsAuthenticated = true
    req.skPrincipal = { identifier: req.get('X-Test-User') || role }
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
    scope: path.dirname(root),
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

test('local discovery lists the same complete, filterable resources as HTTP', async (t) => {
  const f = await fixture(t)
  const { record } = await publication(f)
  const registry =
    globalThis[Symbol.for('macjl.forecast-datasets.catalogues.v1')]
  const service = registry.get(f.scope)
  const filter = { format: 'grib2', kind: 'forecast', state: 'complete' }
  const list = service.datasets(filter)
  const response = await f.call(`/datasets?${new URLSearchParams(filter)}`, {
    role: 'readonly'
  })
  assert.deepEqual(list, await response.json())
  assert.deepEqual(service.datasets({ ...filter, offset: 1 }), {})
  assert.deepEqual(service.datasets({ ...filter, format: 'zarr' }), {})
  assert.deepEqual(service.dataset(record.id, record.version), record)
  const chunks = []
  for await (const part of service.readAsset(
    record.id,
    record.version,
    'forecast',
    new AbortController().signal
  )) {
    chunks.push(part)
  }
  assert.deepEqual(Buffer.concat(chunks), content)
})

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

test('automatically enriches an existing GRIB version and preserves its prior inventory', async (t) => {
  const f = await fixture(t)
  const { record, asset } = await publication(f)
  const versionPath = `/datasets/${record.id}/versions/${record.version}`
  const initial = await f.call(versionPath)
  const index = {
    messages: [{ assetId: 'forecast', offset: 0, length: content.length }]
  }
  const enriched = await f.call(versionPath + '/inventory', {
    method: 'PUT',
    headers: { 'If-Match': initial.headers.get('etag') },
    json: {
      metadata: { model: 'existing-index', grid: { resolution: '0025' } },
      index
    }
  })
  assert.equal(enriched.status, 200)
  const before = await f.call(asset)
  const registry = (globalThis[
    Symbol.for('macjl.forecast-datasets.processors.v1')
  ] ??= new Map())
  let calls = 0
  const times = [
    '2026-11-19T06:00:00Z',
    '2026-11-19T07:30:00Z',
    '2026-11-19T09:00:00Z'
  ]
  registry.set(os.tmpdir(), {
    id: 'test-processor',
    capabilities: () => [],
    async analyze({ paths }) {
      calls++
      assert.deepEqual(await fs.readFile(paths[0]), content)
      return {
        run: times[0],
        forecastTimes: times,
        bounds: [-6, 45, -5.9, 45.1],
        grid: { bboxCrop: true }
      }
    }
  })
  t.after(() => registry.delete(os.tmpdir()))
  const deadline = Date.now() + 12_000
  let detail
  do {
    await new Promise((resolve) => setTimeout(resolve, 50))
    detail = await (await f.call(versionPath, { role: 'readonly' })).json()
  } while (!detail.forecast?.times && Date.now() < deadline)
  assert.deepEqual(detail.forecast, {
    from: '2026-11-19T06:00:00.000Z',
    to: '2026-11-19T09:00:00.000Z',
    times: times.map((time) => new Date(time).toISOString()),
    stepSeconds: 5400
  })
  assert.equal(detail.version, record.version)
  assert.equal(detail.metadataRevision, 3)
  assert.equal(detail.model, 'existing-index')
  assert.deepEqual(detail.bounds, [-6, 45, -5.9, 45.1])
  assert.deepEqual(detail.grid, { resolution: '0025', bboxCrop: true })
  const inventory = await (await f.call(versionPath + '/index')).json()
  assert.deepEqual(inventory.index, index)
  const summary = (await f.provider.methods.listResources({}))[record.id]
  assert.equal(summary.forecast.stepSeconds, 5400)
  assert.equal(summary.forecast.times, undefined)
  assert.equal(
    (await f.call(asset)).headers.get('etag'),
    before.headers.get('etag')
  )
  assert.ok(
    f.deltas.some(
      ([, delta]) => delta.updates[0].values[0].value?.metadataRevision === 3
    )
  )
  assert.equal(calls, 1)
})

test('leases the same original to several exports and returns Retry-After at the configured limit', async (t) => {
  const f = await fixture(t, { maxConcurrentExports: 3 })
  const { record } = await publication(f)
  const route = `/datasets/${record.id}/versions/${record.version}/requests`
  const registry = (globalThis[
    Symbol.for('macjl.forecast-datasets.processors.v1')
  ] ??= new Map())
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const workerOutputs = new Set()
  registry.set(os.tmpdir(), {
    id: 'test-processor',
    version: '1',
    capabilities: () => [
      {
        operation: 'export',
        output: { format: 'grib2', layout: 'single-file' },
        selectors: ['bbox']
      }
    ],
    async run({ selection, paths, output }) {
      workerOutputs.add(output)
      await gate
      await fs.copyFile(paths[0], output)
      return { messageCount: 1, bounds: selection.bbox }
    }
  })
  t.after(() => registry.delete(os.tmpdir()))
  const ask = (index) =>
    f.call(route, {
      role: 'readwrite',
      method: 'POST',
      headers: { 'X-Test-User': `boat-${index}` },
      json: { selection: { bbox: [index, 40, index + 1, 41] } }
    })
  let jobs
  try {
    const accepted = await Promise.all([0, 1, 2].map(ask))
    assert.deepEqual(
      accepted.map((res) => res.status),
      [202, 202, 202]
    )
    jobs = await Promise.all(accepted.map((res) => res.json()))
    assert.equal(new Set(jobs.map((job) => job.id)).size, 3)
    assert.equal(workerOutputs.size, 3)
    const excess = await ask(3)
    assert.equal(excess.status, 429)
    assert.equal(excess.headers.get('retry-after'), '1')
    assert.equal((await excess.json()).code, 'PROCESSING_BUSY')
  } finally {
    release()
  }
  const results = await Promise.all(
    jobs.map(async (job, index) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const res = await f.call(job.href.slice(API_ROOT.length), {
          role: 'readwrite',
          headers: { 'X-Test-User': `boat-${index}` }
        })
        const updated = await res.json()
        if (updated.state === 'complete') return updated.result
        assert.equal(updated.state, 'running', updated.error)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.fail('Concurrent export did not finish')
    })
  )
  assert.equal(new Set(results.map((result) => result.id)).size, 3)
  assert.equal(new Set(results.map((result) => result.name)).size, 3)
  assert.ok(
    results.every(
      (result) => result.provenance.source.version === record.version
    )
  )
})

test('optional processor exports an immutable version for the requesting identity', async (t) => {
  const f = await fixture(t)
  const { record } = await publication(f)
  const route = `/datasets/${record.id}/versions/${record.version}/requests`
  const json = {
    operation: 'export',
    output: { format: 'grib2', layout: 'single-file' }
  }
  assert.equal((await f.call(route, { method: 'POST', json })).status, 503)
  const key = Symbol.for('macjl.forecast-datasets.processors.v1')
  const registry = (globalThis[key] ??= new Map())
  const scope = os.tmpdir()
  const selections = []
  registry.set(scope, {
    id: 'test-processor',
    version: '1',
    capabilities: (_record, support) => {
      assert.deepEqual(support, {
        timeRanges: true,
        unlistedFields: true,
        verifiedGrid: true
      })
      return [{ ...json, selectors: ['from', 'to', 'fields'] }]
    },
    async run({ selection, paths, output }) {
      assert.equal(paths.length, 1)
      selections.push(selection)
      await fs.copyFile(paths[0], output)
      return {
        messageCount: 1,
        ...(selection.from
          ? { forecastTimes: ['2026-11-19T06:00:00Z', '2026-11-19T09:00:00Z'] }
          : {})
      }
    }
  })
  t.after(() => registry.delete(scope))
  const advertised = (await f.provider.methods.listResources({}))[record.id]
    .capabilities.operations[0]
  assert.equal(advertised.href, API_ROOT + route)
  assert.equal(advertised.maxInputBytes, 1024 ** 3)
  assert.deepEqual(advertised.selectors, ['from', 'to', 'fields'])
  const response = await f.call(advertised.href.slice(API_ROOT.length), {
    method: 'POST',
    role: 'readwrite'
  })
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('retry-after'), '1')
  let job = await response.json()
  const jobPath = job.href.slice(API_ROOT.length)
  assert.equal((await f.call(jobPath, { role: 'readonly' })).status, 404)
  for (let attempt = 0; job.state === 'running' && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    job = await (await f.call(jobPath, { role: 'readwrite' })).json()
  }
  assert.equal(job.state, 'complete')
  const result = job.result
  assert.notEqual(result.id, record.id)
  assert.ok(result.expiresAt)
  assert.equal(
    result.assets[0].sha256,
    createHash('sha256').update(content).digest('hex')
  )
  const listed = await f.provider.methods.listResources({})
  assert.equal(listed[result.id].expiresAt, result.expiresAt)
  const read = await f.call(result.href.slice(API_ROOT.length), {
    role: 'readonly'
  })
  assert.equal(read.status, 200)
  assert.deepEqual((await read.json()).provenance.source, {
    id: record.id,
    version: record.version
  })
  const data = await f.call(result.assets[0].href.slice(API_ROOT.length), {
    role: 'readonly',
    headers: { Range: 'bytes=0-3' }
  })
  assert.equal(data.status, 206)
  assert.match(data.headers.get('cache-control'), /no-store/)
  assert.equal(await data.text(), 'GRIB')
  const repeated = await f.call(route, {
    method: 'POST',
    json,
    role: 'readwrite'
  })
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json()).id, job.id)
  const requested = await f.call(route, {
    method: 'POST',
    json: { ...json, expiresInSeconds: null },
    role: 'readwrite'
  })
  assert.equal(requested.status, 202)
  let durable = await requested.json()
  for (
    let attempt = 0;
    durable.state === 'running' && attempt < 100;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    durable = await (
      await f.call(durable.href.slice(API_ROOT.length), { role: 'readwrite' })
    ).json()
  }
  assert.equal(durable.state, 'complete')
  assert.equal(durable.result.expiresAt, undefined)
  assert.equal(
    durable.result.version,
    result.version,
    'retention does not change byte identity'
  )

  const from = '2026-11-19T05:40:00Z'
  const to = '2026-11-19T09:10:00Z'
  for (const invalid of [{ from }, { from: to, to: from }]) {
    assert.equal(
      (
        await f.call(route, {
          method: 'POST',
          json: { selection: invalid },
          role: 'readwrite'
        })
      ).status,
      400
    )
  }
  const range = await f.call(route, {
    method: 'POST',
    json: { selection: { from, to } },
    role: 'readwrite'
  })
  assert.equal(range.status, 202)
  let subset = await range.json()
  for (
    let attempt = 0;
    subset.state === 'running' && attempt < 100;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    subset = await (
      await f.call(subset.href.slice(API_ROOT.length), { role: 'readwrite' })
    ).json()
  }
  assert.equal(subset.state, 'complete')
  assert.deepEqual(selections.at(-1), {
    from: '2026-11-19T05:40:00.000Z',
    to: '2026-11-19T09:10:00.000Z'
  })
  assert.deepEqual(subset.result.forecast, {
    from: '2026-11-19T06:00:00.000Z',
    to: '2026-11-19T09:00:00.000Z'
  })
})
