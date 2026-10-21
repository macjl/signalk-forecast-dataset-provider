// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  API_ROOT,
  CONTRACT_VERSION,
  DEFAULT_LIMITS,
  type Asset,
  type Declaration,
  type Inventory,
  type Limits,
  type Publication,
  type Staging,
  type Version
} from './types'
import {
  ApiError,
  declaration,
  ensure,
  identifier,
  inventory
} from './validation'

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex')

async function syncDir(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(tmp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${canonical(value)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
    await syncDir(path.dirname(file))
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

export class Catalogue {
  private versions = new Map<string, Map<string, Version>>()
  private heads = new Map<string, string>()
  private staged = new Map<string, Staging>()
  private receiving = new Map<string, { assetId: string; bytes: number }>()
  private locks = new Map<string, Promise<void>>()
  private readers = new Map<string, number>()
  private deleting = new Set<string>()
  private drained = new Set<() => void>()
  private accepting = true

  constructor(
    public readonly root: string,
    public readonly limits: Limits = DEFAULT_LIMITS,
    private readonly changed: (
      id: string,
      value: object | null
    ) => void = () => {}
  ) {}

  private directory(...parts: string[]): string {
    return path.join(this.root, ...parts)
  }
  private stageDir(id: string): string {
    return this.directory('staging', identifier(id))
  }
  private versionDir(id: string, version: string): string {
    return this.directory(
      'datasets',
      identifier(id),
      'versions',
      identifier(version)
    )
  }

  private async exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(key, current)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
  }
  private ready(): void {
    if (!this.accepting)
      throw new ApiError(503, 'STOPPED', 'Catalogue is stopping')
  }

  async init(): Promise<void> {
    for (const folder of ['datasets', 'staging', 'trash'])
      await fs.mkdir(this.directory(folder), { recursive: true })
    // Only explicitly tombstoned datasets are reclaimed automatically.
    for (const item of await fs.readdir(this.directory('trash'))) {
      identifier(item)
      await fs.rm(this.directory('trash', item), {
        recursive: true,
        force: true
      })
    }
    for (const id of await fs.readdir(this.directory('datasets'))) {
      identifier(id)
      const headFile = this.directory('datasets', id, 'head.json')
      let head: { version: string; versions: string[] }
      try {
        head = await readJson(headFile)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // interrupted first publication: not visible
        throw error
      }
      ensure(
        Array.isArray(head.versions) && head.versions.includes(head.version),
        `Invalid version history for ${id}`
      )
      const versions = new Map<string, Version>()
      for (const version of head.versions) {
        let record: Version
        try {
          record = await readJson<Version>(
            path.join(this.versionDir(id, version), 'record.json')
          )
        } catch (error) {
          throw new Error(
            `Cannot load published version ${id}/${version}: ${String(error)}`
          )
        }
        ensure(
          record.id === id &&
            record.version === version &&
            record.state === 'complete' &&
            record.contractVersion === CONTRACT_VERSION,
          `Invalid persisted dataset ${id}`
        )
        for (const asset of record.assets) {
          const stat = await fs.lstat(
            path.join(
              this.versionDir(id, version),
              'assets',
              identifier(asset.id)
            )
          )
          ensure(
            stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.size,
            `Missing or changed asset ${id}/${asset.id}`
          )
        }
        versions.set(version, record)
      }
      ensure(versions.has(head.version), `Missing head version for ${id}`)
      this.versions.set(id, versions)
      this.heads.set(id, head.version)
    }
    for (const id of await fs.readdir(this.directory('staging'))) {
      identifier(id)
      let stage: Staging
      try {
        stage = await readJson<Staging>(
          path.join(this.stageDir(id), 'publication.json')
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        let files: string[] = []
        try {
          files = await fs.readdir(path.join(this.stageDir(id), 'assets'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        ensure(
          files.length === 0,
          'Staged bytes exist without their declaration; refusing to discard them'
        )
        await fs.rm(this.stageDir(id), { recursive: true, force: true })
        continue
      }
      ensure(stage.id === id, 'Invalid staging manifest')
      identifier(stage.datasetId)
      declaration(stage.declaration, this.limits)
      // A completed upload was renamed to its asset ID. Rehash on staging recovery
      // so a crash between the file rename and manifest update is resumable.
      stage.uploaded = {}
      for (const expected of stage.declaration.assets) {
        const file = path.join(this.stageDir(id), 'assets', expected.id)
        try {
          const stat = await fs.lstat(file)
          ensure(
            stat.isFile() &&
              !stat.isSymbolicLink() &&
              stat.size > 0 &&
              stat.size <= this.limits.maxAssetBytes &&
              (expected.size === undefined || stat.size === expected.size),
            'Invalid staged asset'
          )
          const hash = createHash('sha256')
          const handle = await fs.open(file, 'r')
          try {
            for await (const chunk of handle.createReadStream({
              autoClose: false
            }))
              hash.update(chunk)
          } finally {
            await handle.close()
          }
          const sha256 = hash.digest('hex')
          ensure(
            !expected.sha256 || expected.sha256 === sha256,
            'Staged asset checksum mismatch'
          )
          stage.uploaded[expected.id] = {
            id: expected.id,
            size: stat.size,
            sha256,
            mediaType: expected.mediaType ?? 'application/octet-stream'
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      for (const file of await fs.readdir(
        path.join(this.stageDir(id), 'assets')
      ))
        if (file.endsWith('.part'))
          await fs.rm(path.join(this.stageDir(id), 'assets', file))
      ensure(
        stage.declaration.assets.reduce(
          (sum, asset) =>
            sum + (stage.uploaded[asset.id]?.size ?? asset.size ?? 0),
          0
        ) <= this.limits.maxDatasetBytes,
        'Recovered publication exceeds configured dataset size limit'
      )
      this.staged.set(id, stage)
      await atomicJson(path.join(this.stageDir(id), 'publication.json'), stage)
    }
  }

  async close(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.locks.values()])
    if (this.readers.size)
      await new Promise<void>((resolve) => this.drained.add(resolve))
  }

  async begin(input: unknown, datasetId?: string): Promise<Publication> {
    return this.exclusive('catalogue', async () => {
      this.ready()
      if (this.staged.size >= this.limits.maxStaging)
        throw new ApiError(
          429,
          'STAGING_LIMIT',
          'Too many unfinished publications'
        )
      const declared = declaration(input, this.limits)
      if (datasetId) this.get(datasetId)
      const stage: Staging = {
        id: randomUUID(),
        datasetId: datasetId ?? randomUUID(),
        createdAt: new Date().toISOString(),
        declaration: declared,
        uploaded: {}
      }
      await fs.mkdir(path.join(this.stageDir(stage.id), 'assets'), {
        recursive: true
      })
      await atomicJson(
        path.join(this.stageDir(stage.id), 'publication.json'),
        stage
      )
      this.staged.set(stage.id, stage)
      return this.publication(stage.id)
    })
  }

  private stage(id: string): Staging {
    identifier(id)
    const stage = this.staged.get(id)
    if (!stage)
      throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Publication not found')
    return structuredClone(stage)
  }

  publications(): Record<string, Publication> {
    this.ready()
    return Object.fromEntries(
      [...this.staged.values()]
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
        )
        .map((stage) => [stage.id, this.publication(stage.id)])
    )
  }

  publication(id: string): Publication {
    this.ready()
    const stage = this.stage(id)
    const active = this.receiving.get(id)
    const assets: Publication['progress']['assets'] = {}
    let bytesReceived = 0
    let totalBytes: number | null = 0
    let assetsCompleted = 0
    for (const declared of stage.declaration.assets) {
      const uploaded = stage.uploaded[declared.id]
      const bytes =
        uploaded?.size ?? (active?.assetId === declared.id ? active.bytes : 0)
      const total = uploaded?.size ?? declared.size ?? null
      assets[declared.id] = {
        state: uploaded
          ? 'complete'
          : active?.assetId === declared.id
            ? 'receiving'
            : 'pending',
        bytesReceived: bytes,
        totalBytes: total
      }
      bytesReceived += bytes
      if (total === null) totalBytes = null
      else if (totalBytes !== null) totalBytes += total
      if (uploaded) assetsCompleted++
    }
    return {
      ...stage,
      state: active
        ? 'receiving'
        : assetsCompleted === stage.declaration.assets.length
          ? 'ready'
          : 'pending',
      progress: {
        bytesReceived,
        totalBytes,
        assetsCompleted,
        assetsTotal: stage.declaration.assets.length,
        assets
      }
    }
  }

  async upload(id: string, assetId: string, stream: Readable): Promise<Asset> {
    return this.exclusive(`publication:${identifier(id)}`, async () => {
      this.ready()
      identifier(assetId)
      const stage = this.stage(id)
      const expected = stage.declaration.assets.find((a) => a.id === assetId)
      if (!expected)
        throw new ApiError(404, 'ASSET_NOT_DECLARED', 'Asset was not declared')
      if (stage.uploaded[assetId])
        throw new ApiError(
          409,
          'ASSET_EXISTS',
          'Asset already uploaded; use publication status to resume'
        )
      const tmp = path.join(
        this.stageDir(id),
        'assets',
        `${assetId}.${randomUUID()}.part`
      )
      const file = path.join(this.stageDir(id), 'assets', assetId)
      const hash = createHash('sha256')
      // Uploads are serialised per publication. Reserve the known sizes of other
      // assets and count actual completed sizes, including formerly unknown ones.
      const otherBytes = stage.declaration.assets.reduce(
        (sum, asset) =>
          sum +
          (asset.id === assetId
            ? 0
            : (stage.uploaded[asset.id]?.size ?? asset.size ?? 0)),
        0
      )
      const assetLimit = this.limits.maxAssetBytes
      const datasetLimit = this.limits.maxDatasetBytes
      const progress = { assetId, bytes: 0 }
      this.receiving.set(id, progress)
      let bytes = 0
      const check = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (expected.size !== undefined && bytes > expected.size) {
            callback(
              new ApiError(413, 'SIZE_EXCEEDED', 'Upload exceeds declared size')
            )
            return
          }
          if (bytes > assetLimit || bytes + otherBytes > datasetLimit) {
            callback(
              new ApiError(
                413,
                'SIZE_LIMIT_EXCEEDED',
                'Upload exceeds configured asset or dataset size limit'
              )
            )
            return
          }
          progress.bytes = bytes
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      try {
        await pipeline(
          stream,
          check,
          createWriteStream(tmp, { flags: 'wx', mode: 0o600 })
        )
        ensure(
          bytes > 0 && (expected.size === undefined || bytes === expected.size),
          'Upload size does not match declaration'
        )
        const sha256 = hash.digest('hex')
        ensure(
          !expected.sha256 || sha256 === expected.sha256,
          'Upload checksum does not match declaration'
        )
        // Windows FlushFileBuffers requires a writable handle. Keep the flush
        // before rename without truncating or rewriting the received bytes.
        const handle = await fs.open(tmp, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.rename(tmp, file)
        await syncDir(path.dirname(file))
        const asset: Asset = {
          id: assetId,
          size: bytes,
          sha256,
          mediaType: expected.mediaType ?? 'application/octet-stream'
        }
        stage.uploaded[assetId] = asset
        await atomicJson(
          path.join(this.stageDir(id), 'publication.json'),
          stage
        )
        this.staged.set(id, stage)
        return structuredClone(asset)
      } catch (error) {
        await fs.rm(tmp, { force: true })
        throw error
      } finally {
        this.receiving.delete(id)
      }
    })
  }

  async commit(id: string): Promise<Version> {
    return this.exclusive(`publication:${identifier(id)}`, () =>
      this.exclusive('catalogue', async () => {
        this.ready()
        const stage = this.publication(id)
        const assets = stage.declaration.assets.map((a) => stage.uploaded[a.id])
        if (assets.some((a) => !a))
          throw new ApiError(
            409,
            'INCOMPLETE_PUBLICATION',
            'Every declared asset must be uploaded before commit'
          )
        const complete = (assets as Asset[]).sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        )
        const { declaration: d, datasetId } = stage
        const version = digest({
          kind: d.kind,
          format: d.format,
          assets: complete
        })
        const existing = this.versions.get(datasetId)?.get(version)
        const record: Version = existing ?? {
          contractVersion: CONTRACT_VERSION,
          id: datasetId,
          version,
          kind: d.kind,
          format: d.format,
          producer: d.producer,
          state: 'complete',
          createdAt: new Date().toISOString(),
          metadataRevision: 1,
          metadata: d.metadata,
          requested: d.requested,
          provenance: d.provenance,
          assets: complete
        }
        const dir = this.versionDir(datasetId, version)
        await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
        if (!existing) {
          // Keep staging until head is durable. Hard links do not duplicate bytes;
          // a crash at any earlier step can resume without another upload.
          for (const asset of complete) {
            try {
              await fs.link(
                path.join(this.stageDir(id), 'assets', asset.id),
                path.join(dir, 'assets', asset.id)
              )
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error
            }
          }
          await syncDir(path.join(dir, 'assets'))
          await atomicJson(path.join(dir, 'record.json'), record)
          await syncDir(path.dirname(dir))
        }
        const versions =
          this.versions.get(datasetId) ?? new Map<string, Version>()
        // The head and history are the single atomic publication boundary.
        await atomicJson(this.directory('datasets', datasetId, 'head.json'), {
          version,
          versions: [...new Set([...versions.keys(), version])].sort()
        })
        await syncDir(this.directory('datasets'))
        versions.set(version, record)
        this.versions.set(datasetId, versions)
        this.heads.set(datasetId, version)
        this.staged.delete(id)
        await fs.rm(this.stageDir(id), { recursive: true, force: true })
        this.changed(datasetId, this.resource(record))
        return structuredClone(record)
      })
    )
  }

  async abort(id: string): Promise<void> {
    return this.exclusive(`publication:${identifier(id)}`, () =>
      this.exclusive('catalogue', async () => {
        this.ready()
        const stage = this.publication(id)
        await fs.rm(this.stageDir(id), { recursive: true, force: true })
        this.staged.delete(id)
        if (!this.heads.has(stage.datasetId))
          await fs.rm(this.directory('datasets', stage.datasetId), {
            recursive: true,
            force: true
          })
      })
    )
  }

  get(id: string, version?: string): Version {
    this.ready()
    identifier(id)
    if (this.deleting.has(id))
      throw new ApiError(409, 'DATASET_BUSY', 'Dataset deletion is in progress')
    if (version) identifier(version)
    const record = this.versions
      .get(id)
      ?.get(version ?? this.heads.get(id) ?? '')
    if (!record)
      throw new ApiError(404, 'DATASET_NOT_FOUND', 'Dataset/version not found')
    return structuredClone(record)
  }
  all(): Version[] {
    return [...this.heads]
      .filter(([id]) => !this.deleting.has(id))
      .map(([id]) => this.get(id))
  }

  private acquire(id: string): () => void {
    this.readers.set(id, (this.readers.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.readers.get(id) ?? 1) - 1
      if (n) this.readers.set(id, n)
      else this.readers.delete(id)
      if (!this.readers.size) {
        for (const resolve of this.drained) resolve()
        this.drained.clear()
      }
    }
  }

  async readInventory(
    id: string,
    version: string
  ): Promise<{ record: Version; inventory: Inventory }> {
    const record = this.get(id, version)
    if (!record.inventory)
      throw new ApiError(
        404,
        'INVENTORY_UNAVAILABLE',
        'No verified inventory has been supplied'
      )
    const release = this.acquire(id)
    try {
      const index = await readJson<Inventory['index']>(
        path.join(
          this.versionDir(id, version),
          'indexes',
          `${record.inventory.indexHash}.json`
        )
      )
      return {
        record,
        inventory: { metadata: record.inventory.metadata, index }
      }
    } finally {
      release()
    }
  }

  resource(record: Version, summary = false): Record<string, unknown> {
    const prefix = `${API_ROOT}/datasets/${record.id}/versions/${record.version}`
    const result: Record<string, unknown> = {
      contractVersion: CONTRACT_VERSION,
      id: record.id,
      version: record.version,
      kind: record.kind,
      format: record.format,
      producer: record.producer,
      state: record.state,
      createdAt: record.createdAt,
      metadataRevision: record.metadataRevision,
      ...record.metadata,
      ...record.inventory?.metadata,
      inventory: {
        status: record.inventory ? 'verified' : 'unverified',
        ...(record.inventory ? { href: `${prefix}/index` } : {})
      },
      size: record.assets.reduce((sum, a) => sum + a.size, 0),
      assetCount: record.assets.length,
      href: `${API_ROOT}/datasets/${record.id}`,
      capabilities: { operations: [] }
    }
    if (!summary) {
      result.declared = record.metadata
      if (record.requested) result.requested = record.requested
      if (record.provenance) result.provenance = record.provenance
      result.assets = record.assets.map((a) => ({
        ...a,
        href: `${prefix}/assets/${a.id}`,
        byteRanges: true
      }))
    }
    return result
  }

  async enrich(
    id: string,
    version: string,
    value: unknown,
    revision: number
  ): Promise<Version> {
    return this.exclusive('catalogue', async () => {
      const record = this.get(id, version)
      if (record.metadataRevision !== revision)
        throw new ApiError(412, 'REVISION_CHANGED', 'Metadata revision changed')
      const verified: Inventory = inventory(value)
      // Index payloads are opaque to storage. Check range bindings if messages are supplied.
      if (Array.isArray(verified.index.messages))
        for (const message of verified.index.messages) {
          ensure(
            message !== null &&
              typeof message === 'object' &&
              !Array.isArray(message),
            'Invalid index message'
          )
          const m = message as Record<string, unknown>
          const asset = record.assets.find((a) => a.id === m.assetId)
          ensure(
            asset &&
              Number.isSafeInteger(m.offset) &&
              Number.isSafeInteger(m.length) &&
              (m.offset as number) >= 0 &&
              (m.length as number) > 0 &&
              (m.offset as number) + (m.length as number) <= asset.size,
            'Index message lies outside its asset'
          )
        }
      const indexHash = digest(verified.index)
      const indexDir = path.join(this.versionDir(id, version), 'indexes')
      await fs.mkdir(indexDir, { recursive: true })
      await atomicJson(path.join(indexDir, `${indexHash}.json`), verified.index)
      record.inventory = { metadata: verified.metadata, indexHash }
      record.metadataRevision++
      await atomicJson(
        path.join(this.versionDir(id, version), 'record.json'),
        record
      )
      this.versions.get(id)!.set(version, record)
      if (this.heads.get(id) === version)
        this.changed(id, this.resource(record))
      return structuredClone(record)
    })
  }

  async openAsset(id: string, version: string, assetId: string) {
    const record = this.get(id, version)
    const asset = record.assets.find((a) => a.id === identifier(assetId))
    if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found')
    const release = this.acquire(id)
    try {
      const handle = await fs.open(
        path.join(this.versionDir(id, version), 'assets', asset.id),
        'r'
      )
      try {
        const stat = await handle.stat()
        ensure(
          stat.isFile() && stat.size === asset.size,
          'Stored asset size changed'
        )
      } catch (error) {
        await handle.close()
        throw error
      }
      return {
        asset,
        handle,
        release: async () => {
          await handle.close().finally(release)
        }
      }
    } catch (error) {
      release()
      throw error
    }
  }

  async remove(id: string, notify = true): Promise<void> {
    return this.exclusive('catalogue', async () => {
      this.get(id)
      if (
        this.readers.has(id) ||
        [...this.staged.values()].some((s) => s.datasetId === id)
      )
        throw new ApiError(
          409,
          'DATASET_BUSY',
          'Dataset has active readers or publications; retry later'
        )
      const trash = this.directory('trash', randomUUID())
      this.deleting.add(id)
      try {
        await fs.rename(this.directory('datasets', id), trash)
        this.versions.delete(id)
        this.heads.delete(id)
        await syncDir(this.directory('datasets'))
        await syncDir(this.directory('trash'))
      } finally {
        this.deleting.delete(id)
      }
      if (notify) this.changed(id, null)
      await fs.rm(trash, { recursive: true, force: true })
    })
  }
}
