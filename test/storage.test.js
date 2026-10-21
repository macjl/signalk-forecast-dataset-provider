// SPDX-License-Identifier: Apache-2.0
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { Readable, PassThrough } = require('node:stream')
const { createHash, randomUUID } = require('node:crypto')
const { Catalogue, digest } = require('../dist/storage')
const { listResources } = require('../dist/discovery')
const { declaration, date, bounds } = require('../dist/validation')
const { DEFAULT_LIMITS } = require('../dist/types')

const bytes = Buffer.from([71, 82, 73, 66, 0, 255, 128, 42, 13, 10])
const field = {
  parameter: 'eastward_wind',
  level: { type: 'heightAboveGround', value: 10, unit: 'm' }
}
const verified = {
  model: 'GFS',
  run: '2026-10-21T00:00:00Z',
  bounds: [170, -10, -170, 20],
  forecast: { from: '2026-10-21T00:00:00Z', to: '2026-10-23T00:00:00Z' },
  fields: [field]
}
function input(data = [bytes]) {
  return {
    kind: 'forecast',
    format: 'grib2',
    producer: 'test-producer',
    metadata: { model: 'GFS' },
    assets: data.map((b, i) => ({ id: `part-${i}`, size: b.length }))
  }
}
async function fixture(t, limits = DEFAULT_LIMITS) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forecast-store-'))
  const changes = []
  let store = new Catalogue(root, limits, (id, value) =>
    changes.push({ id, value })
  )
  await store.init()
  t.after(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    root,
    changes,
    get store() {
      return store
    },
    async restart() {
      await store.close()
      store = new Catalogue(root, limits, (id, value) =>
        changes.push({ id, value })
      )
      await store.init()
      return store
    }
  }
}
async function publish(store, data = [bytes], id) {
  const p = await store.begin(input(data), id)
  for (let i = 0; i < data.length; i++)
    await store.upload(p.id, `part-${i}`, Readable.from([data[i]]))
  return store.commit(p.id)
}

test('multi-file publication is invisible until all assets commit and bytes remain identical', async (t) => {
  const f = await fixture(t)
  const p = await f.store.begin(input([bytes, Buffer.from('second')]))
  await f.store.upload(p.id, 'part-0', Readable.from([bytes]))
  assert.deepEqual(f.store.all(), [])
  await assert.rejects(
    f.store.commit(p.id),
    (e) => e.code === 'INCOMPLETE_PUBLICATION'
  )
  assert.equal(f.store.publication(p.id).uploaded['part-0'].size, bytes.length)
  await f.store.upload(p.id, 'part-1', Readable.from(['second']))
  const record = await f.store.commit(p.id)
  assert.equal(record.assets.length, 2)
  assert.equal(
    record.assets[0].sha256,
    createHash('sha256').update(bytes).digest('hex')
  )
  const original = await f.store.openAsset(record.id, record.version, 'part-0')
  assert.deepEqual(await original.handle.readFile(), bytes)
  await original.release()
  assert.equal(f.changes.length, 1)
  assert.equal(f.changes[0].value.state, 'complete')
  await f.restart()
  assert.equal(f.store.get(record.id).version, record.version)
})

test('restart recovers completed uploads without downloading them again', async (t) => {
  const f = await fixture(t)
  const p = await f.store.begin(input([bytes, Buffer.from('later')]))
  await f.store.upload(p.id, 'part-0', Readable.from([bytes]))
  await fs.writeFile(
    path.join(f.root, 'staging', p.id, 'assets', 'incomplete.part'),
    'partial'
  )
  await f.restart()
  assert.equal(f.store.publication(p.id).uploaded['part-0'].size, bytes.length)
  await assert.rejects(
    f.store.upload(p.id, 'part-0', Readable.from([bytes])),
    (e) => e.status === 409
  )
  assert.equal(
    (await fs.readdir(path.join(f.root, 'staging', p.id, 'assets'))).length,
    1
  )
  await f.store.upload(p.id, 'part-1', Readable.from(['later']))
  assert.equal((await f.store.commit(p.id)).assets.length, 2)
})

test('unknown-size streams report live progress, survive restart and require explicit commit', async (t) => {
  const f = await fixture(t)
  const declaration = input([bytes, Buffer.from('later')])
  delete declaration.assets[0].size
  delete declaration.assets[1].size
  const p = await f.store.begin(declaration)
  assert.equal(p.state, 'pending')
  assert.equal(p.progress.totalBytes, null)
  assert.deepEqual(Object.keys(f.store.publications()), [p.id])
  const stream = new PassThrough()
  const uploading = f.store.upload(p.id, 'part-0', stream)
  stream.write(bytes.subarray(0, 4))
  for (
    let i = 0;
    i < 100 && f.store.publication(p.id).progress.bytesReceived !== 4;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  const receiving = f.store.publication(p.id)
  assert.equal(receiving.state, 'receiving')
  assert.equal(receiving.progress.bytesReceived, 4)
  assert.equal(receiving.progress.assets['part-0'].state, 'receiving')
  assert.deepEqual(f.store.all(), [])
  stream.end(bytes.subarray(4))
  const asset = await uploading
  assert.equal(asset.size, bytes.length)
  assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(f.store.publication(p.id).progress.assetsCompleted, 1)
  await f.restart()
  assert.equal(f.store.publication(p.id).progress.bytesReceived, bytes.length)
  assert.equal(f.store.publication(p.id).progress.totalBytes, null)
  await f.store.upload(p.id, 'part-1', Readable.from(['later']))
  const ready = f.store.publication(p.id)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.progress.totalBytes, bytes.length + 5)
  assert.equal(ready.progress.assetsCompleted, 2)
  assert.deepEqual(f.store.all(), [])
  const record = await f.store.commit(p.id)
  assert.equal(record.assets.length, 2)
  assert.deepEqual(f.store.publications(), {})
  await f.restart()
  assert.equal(f.store.get(record.id).version, record.version)
})

test('unknown-size streams enforce asset and cumulative dataset limits and reject empty/bad-hash uploads', async (t) => {
  const f = await fixture(t, {
    ...DEFAULT_LIMITS,
    maxAssetBytes: 10,
    maxDatasetBytes: 12
  })
  const p = await f.store.begin({
    ...input(),
    assets: [{ id: 'a' }, { id: 'b' }]
  })
  await assert.rejects(
    f.store.upload(p.id, 'a', Readable.from([Buffer.alloc(11)])),
    (e) => e.status === 413
  )
  await assert.rejects(f.store.upload(p.id, 'a', Readable.from([])), /size/)
  await f.store.upload(p.id, 'a', Readable.from([Buffer.alloc(8)]))
  await assert.rejects(
    f.store.upload(p.id, 'b', Readable.from([Buffer.alloc(5)])),
    (e) => e.status === 413
  )
  assert.equal(f.store.publication(p.id).state, 'pending')
  assert.equal(f.store.publication(p.id).progress.bytesReceived, 8)
  await f.restart()
  await f.store.upload(p.id, 'b', Readable.from([Buffer.alloc(4)]))
  assert.equal(
    (await f.store.commit(p.id)).assets.reduce((n, a) => n + a.size, 0),
    12
  )
  const q = await f.store.begin({
    ...input(),
    assets: [{ id: 'a', sha256: '0'.repeat(64) }]
  })
  await assert.rejects(
    f.store.upload(q.id, 'a', Readable.from(['abc'])),
    /checksum/
  )
  assert.deepEqual(f.store.publication(q.id).uploaded, {})
  assert.deepEqual(
    await fs.readdir(path.join(f.root, 'staging', q.id, 'assets')),
    []
  )
})

test('known-size reservations and broken unknown streams never consume other completed assets', async (t) => {
  const f = await fixture(t, { ...DEFAULT_LIMITS, maxDatasetBytes: 12 })
  const p = await f.store.begin({
    ...input(),
    assets: [{ id: 'a' }, { id: 'b', size: 8 }]
  })
  await assert.rejects(
    f.store.upload(p.id, 'a', Readable.from([Buffer.alloc(5)])),
    (e) => e.status === 413
  )
  await f.store.upload(p.id, 'b', Readable.from([Buffer.alloc(8)]))
  const broken = new Readable({
    read() {
      this.push('abc')
      this.destroy(new Error('upstream failed'))
    }
  })
  await assert.rejects(f.store.upload(p.id, 'a', broken), /upstream failed/)
  assert.equal(f.store.publication(p.id).progress.bytesReceived, 8)
  await fs.writeFile(
    path.join(f.root, 'staging', p.id, 'assets', 'interrupted.part'),
    'ab'
  )
  await f.restart()
  assert.equal(f.store.publication(p.id).progress.assets.a.state, 'pending')
  assert.equal(f.store.publication(p.id).uploaded.b.size, 8)
  await f.store.upload(p.id, 'a', Readable.from(['abcd']))
  assert.equal((await f.store.commit(p.id)).assets.length, 2)
})

test('interrupted head publication resumes from staged bytes after restart', async (t) => {
  const f = await fixture(t)
  const p = await f.store.begin(input())
  await f.store.upload(p.id, 'part-0', Readable.from([bytes]))
  const rename = fs.rename
  fs.rename = async (a, b) => {
    if (path.basename(String(b)) === 'head.json')
      throw new Error('simulated power loss before head')
    return rename(a, b)
  }
  try {
    await assert.rejects(f.store.commit(p.id), /simulated power loss/)
  } finally {
    fs.rename = rename
  }
  assert.deepEqual(f.store.all(), [])
  await f.restart()
  assert.equal(f.store.publication(p.id).uploaded['part-0'].size, bytes.length)
  assert.equal((await f.store.commit(p.id)).state, 'complete')
})

test('uncommitted version of an existing dataset never becomes visible after restart', async (t) => {
  const f = await fixture(t)
  const first = await publish(f.store)
  const p = await f.store.begin(input([Buffer.from('new-run')]), first.id)
  await f.store.upload(p.id, 'part-0', Readable.from(['new-run']))
  const rename = fs.rename
  fs.rename = async (a, b) => {
    if (path.basename(String(b)) === 'head.json')
      throw new Error('head failure')
    return rename(a, b)
  }
  try {
    await assert.rejects(f.store.commit(p.id), /head failure/)
  } finally {
    fs.rename = rename
  }
  const stagedVersion = digest({
    kind: p.declaration.kind,
    format: p.declaration.format,
    assets: Object.values(f.store.publication(p.id).uploaded)
  })
  await f.restart()
  assert.equal(f.store.get(first.id).version, first.version)
  assert.throws(
    () => f.store.get(first.id, stagedVersion),
    (e) => e.status === 404
  )
  assert.equal((await f.store.commit(p.id)).version, stagedVersion)
  assert.equal(f.store.get(first.id, first.version).version, first.version)
})

test('short, oversized, bad-checksum and aborted uploads leave no completed asset', async (t) => {
  const f = await fixture(t)
  const p = await f.store.begin(input())
  await assert.rejects(
    f.store.upload(p.id, 'part-0', Readable.from(['short'])),
    /size/
  )
  await assert.rejects(
    f.store.upload(p.id, 'part-0', Readable.from([Buffer.alloc(100)])),
    (e) => e.status === 413
  )
  const interrupted = new Readable({
    read() {
      this.push(Buffer.from('a'))
      this.destroy(new Error('connection lost'))
    }
  })
  await assert.rejects(
    f.store.upload(p.id, 'part-0', interrupted),
    /connection lost/
  )
  assert.deepEqual(f.store.publication(p.id).uploaded, {})
  assert.deepEqual(
    await fs.readdir(path.join(f.root, 'staging', p.id, 'assets')),
    []
  )
  const bad = input()
  bad.assets[0].sha256 = '0'.repeat(64)
  const q = await f.store.begin(bad)
  await assert.rejects(
    f.store.upload(q.id, 'part-0', Readable.from([bytes])),
    /checksum/
  )
  await f.store.upload(p.id, 'part-0', Readable.from([bytes]))
  assert.equal((await f.store.commit(p.id)).state, 'complete')
})

test('metadata enrichment keeps content identity and requires exact index bounds and revision', async (t) => {
  const f = await fixture(t)
  const record = await publish(f.store)
  const inv = {
    metadata: verified,
    index: {
      messages: [
        {
          assetId: 'part-0',
          offset: 0,
          length: bytes.length,
          parameter: field.parameter
        }
      ]
    }
  }
  const updated = await f.store.enrich(record.id, record.version, inv, 1)
  assert.equal(updated.version, record.version)
  assert.equal(updated.metadataRevision, 2)
  assert.equal(updated.assets[0].sha256, record.assets[0].sha256)
  await assert.rejects(
    f.store.enrich(record.id, record.version, inv, 1),
    (e) => e.status === 412
  )
  inv.index.messages[0].length = bytes.length + 1
  await assert.rejects(
    f.store.enrich(record.id, record.version, inv, 2),
    /outside/
  )
  await f.restart()
  assert.equal(f.store.get(record.id).metadataRevision, 2)
})

test('verified discovery excludes unknown coverage and supports dateline containment and field levels', async (t) => {
  const f = await fixture(t)
  const a = await publish(f.store)
  const b = await publish(f.store)
  await f.store.enrich(a.id, a.version, { metadata: verified, index: {} }, 1)
  assert.equal(Object.keys(listResources(f.store, { model: 'GFS' })).length, 2)
  assert.deepEqual(
    Object.keys(
      listResources(f.store, {
        bbox: '175,0,-175,10',
        fields: JSON.stringify([field]),
        from: '2026-10-21T12:00:00Z',
        to: '2026-10-22T00:00:00Z'
      })
    ),
    [a.id]
  )
  assert.deepEqual(listResources(f.store, { bbox: '-5,0,5,5' }), {})
  assert.deepEqual(
    listResources(f.store, {
      fields: [{ ...field, level: { ...field.level, value: 80 } }]
    }),
    {}
  )
  assert.deepEqual(Object.keys(listResources(f.store, { verified: false })), [
    b.id
  ])
  assert.equal(
    Object.keys(
      listResources(f.store, { bbox: '160,0,175,5', coverage: 'overlaps' })
    ).length,
    1
  )
  assert.equal(
    Object.keys(listResources(f.store, { limit: 1, offset: 1 })).length,
    1
  )
  assert.throws(
    () => listResources(f.store, { unexpected: 'ignored?' }),
    /Unknown/
  )
})

test('retention refuses active reads and staging and emits deletion only after removal', async (t) => {
  const f = await fixture(t)
  const record = await publish(f.store)
  const opened = await f.store.openAsset(record.id, record.version, 'part-0')
  await assert.rejects(
    f.store.remove(record.id),
    (e) => e.code === 'DATASET_BUSY'
  )
  await opened.release()
  const p = await f.store.begin(input(), record.id)
  await assert.rejects(
    f.store.remove(record.id),
    (e) => e.code === 'DATASET_BUSY'
  )
  await f.store.abort(p.id)
  await f.store.remove(record.id)
  assert.equal(f.changes.at(-1).value, null)
  await f.restart()
  assert.deepEqual(f.store.all(), [])
})

test('reader arriving during deletion cannot acquire a disappearing asset', async (t) => {
  const f = await fixture(t)
  const record = await publish(f.store)
  const rename = fs.rename
  let release
  const pause = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const waiting = new Promise((resolve) => {
    entered = resolve
  })
  fs.rename = async (a, b) => {
    if (path.basename(path.dirname(String(b))) === 'trash') {
      entered()
      await pause
    }
    return rename(a, b)
  }
  try {
    const removing = f.store.remove(record.id)
    await waiting
    await assert.rejects(
      f.store.openAsset(record.id, record.version, 'part-0'),
      (e) => e.code === 'DATASET_BUSY'
    )
    release()
    await removing
  } finally {
    release()
    fs.rename = rename
  }
})

test('content versions are order-independent and prior versions remain retrievable', async (t) => {
  const f = await fixture(t)
  const p = await f.store.begin(input([bytes, Buffer.from('other')]))
  await f.store.upload(p.id, 'part-1', Readable.from(['other']))
  await f.store.upload(p.id, 'part-0', Readable.from([bytes]))
  const first = await f.store.commit(p.id)
  const qinput = input([bytes, Buffer.from('other')])
  qinput.assets.reverse()
  const q = await f.store.begin(qinput, first.id)
  await f.store.upload(q.id, 'part-0', Readable.from([bytes]))
  await f.store.upload(q.id, 'part-1', Readable.from(['other']))
  assert.equal((await f.store.commit(q.id)).version, first.version)
  const second = await publish(f.store, [Buffer.from('different')], first.id)
  assert.notEqual(second.version, first.version)
  assert.equal(f.store.get(first.id, first.version).assets.length, 2)
})

test('reject path traversal, false dates, duplicate assets and quota violations', () => {
  for (const id of ['../escape', '/etc/passwd', '__proto__']) {
    const d = input()
    d.assets[0].id = id
    assert.throws(() => declaration(d, DEFAULT_LIMITS))
  }
  assert.throws(() => date('2026-02-30T00:00:00Z', 'date'), /calendar/)
  assert.throws(() => bounds('5,,8,44'), /Empty/)
  const dup = input([bytes, bytes])
  dup.assets[1].id = dup.assets[0].id
  assert.throws(() => declaration(dup, DEFAULT_LIMITS), /Duplicate/)
  assert.throws(
    () => declaration(input(), { ...DEFAULT_LIMITS, maxAssetBytes: 1 }),
    /size/
  )
  const polluted = JSON.parse(
    '{"kind":"forecast","format":"grib2","producer":"x","assets":[{"id":"a","size":1}],"provenance":{"__proto__":{"admin":true}}}'
  )
  assert.throws(() => declaration(polluted, DEFAULT_LIMITS), /Reserved/)
})

test('startup cleans an interrupted empty publication but refuses missing published bytes', async (t) => {
  const f = await fixture(t)
  const empty = path.join(f.root, 'staging', randomUUID())
  await fs.mkdir(empty)
  await f.restart()
  await assert.rejects(fs.access(empty))
  const record = await publish(f.store)
  await f.store.close()
  await fs.unlink(
    path.join(
      f.root,
      'datasets',
      record.id,
      'versions',
      record.version,
      'assets',
      'part-0'
    )
  )
  const broken = new Catalogue(f.root)
  await assert.rejects(broken.init())
})
