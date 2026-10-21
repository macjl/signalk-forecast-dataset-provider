// SPDX-License-Identifier: Apache-2.0
import express, {
  type Request,
  type Response,
  type RequestHandler,
  type ErrorRequestHandler
} from 'express'
import { pipeline } from 'node:stream/promises'
import type { PluginRouter } from '@signalk/server-api'
import { API_ROOT, CONTRACT_VERSION, PLUGIN_ID, RESOURCE_TYPE } from './types'
import { Catalogue, digest } from './storage'
import { listResources } from './discovery'
import { ApiError, ensure } from './validation'

type GetStore = () => Catalogue
const etag = (value: unknown) => `"${digest(value)}"`
function matches(header: string | undefined, tag: string): boolean {
  return Boolean(
    header
      ?.split(',')
      .some(
        (item) => item.trim() === '*' || item.trim().replace(/^W\//, '') === tag
      )
  )
}
function json(req: Request, res: Response, value: unknown): void {
  const tag = etag(value)
  res.set({ ETag: tag, 'Cache-Control': 'private, no-cache, no-transform' })
  if (matches(req.get('If-None-Match'), tag)) {
    res.status(304).end()
    return
  }
  res.json(value)
}
export function byteRange(
  header: string,
  size: number
): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  const fail = () => {
    throw new ApiError(
      416,
      'INVALID_RANGE',
      'One satisfiable bytes range is required'
    )
  }
  if (!match || (!match[1] && !match[2])) return fail()
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return fail()
  const start = first ?? Math.max(0, size - (last ?? 0))
  const end =
    first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1)
  if (
    start < 0 ||
    start >= size ||
    end < start ||
    (first === undefined && !last)
  )
    return fail()
  return { start, end }
}

export function registerRoutes(
  router: PluginRouter,
  getStore: GetStore,
  report: (message: string) => void
): void {
  const parse = express.json({ limit: '2mb', strict: true })
  const body: RequestHandler = (req, res, next) => {
    if (Number(req.get('Content-Length') ?? 0) > 2 * 1024 ** 2) {
      next(new ApiError(413, 'JSON_TOO_LARGE', 'JSON body exceeds 2 MiB'))
      return
    }
    parse(req, res, (error) => {
      if (error) {
        next(error)
        return
      }
      // Signal K may have already parsed JSON before invoking the plugin router.
      if (Buffer.byteLength(JSON.stringify(req.body) ?? '') > 2 * 1024 ** 2)
        next(new ApiError(413, 'JSON_TOO_LARGE', 'JSON body exceeds 2 MiB'))
      else next()
    })
  }
  const wrap =
    (
      fn: (req: Request, res: Response) => Promise<void> | void
    ): RequestHandler =>
    (req, res) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((error) => {
          if (res.headersSent || res.destroyed) {
            if (!res.destroyed) res.destroy()
            return
          }
          const known = error instanceof ApiError
          if (!known)
            report(error instanceof Error ? error.message : String(error))
          res.removeHeader('ETag')
          res.removeHeader('Content-Length')
          res.set('Cache-Control', 'no-store').type('application/json')
          res.status(known ? error.status : 500).json({
            code: known ? error.code : 'INTERNAL_ERROR',
            message: known
              ? error.message
              : 'Catalogue operation failed; see server log'
          })
        })
    }
  const read = router.access('readonly')
  const write = router.access('readwrite')

  read.get(
    '/status',
    wrap((_req, res) => {
      const store = getStore()
      res.json({
        id: PLUGIN_ID,
        contractVersion: CONTRACT_VERSION,
        resourceType: RESOURCE_TYPE,
        datasets: store.all().length,
        operations: [],
        processing: 'not-implemented'
      })
    })
  )
  read.get(
    '/datasets',
    wrap((req, res) => json(req, res, listResources(getStore(), req.query)))
  )
  read.get(
    '/datasets/:id',
    wrap((req, res) => {
      const store = getStore()
      json(req, res, store.resource(store.get(req.params.id!)))
    })
  )
  read.get(
    '/datasets/:id/versions/:version',
    wrap((req, res) => {
      const store = getStore()
      json(
        req,
        res,
        store.resource(store.get(req.params.id!, req.params.version!))
      )
    })
  )
  read.get(
    '/datasets/:id/versions/:version/index',
    wrap(async (req, res) => {
      const store = getStore()
      const { record, inventory } = await store.readInventory(
        req.params.id!,
        req.params.version!
      )
      json(req, res, {
        datasetId: record.id,
        version: record.version,
        metadataRevision: record.metadataRevision,
        assets: record.assets.map((a) => ({
          id: a.id,
          size: a.size,
          sha256: a.sha256
        })),
        ...inventory
      })
    })
  )
  read.get(
    '/datasets/:id/versions/:version/assets/:asset',
    wrap(async (req, res) => {
      const opened = await getStore().openAsset(
        req.params.id!,
        req.params.version!,
        req.params.asset!
      )
      try {
        const { asset, handle } = opened
        const tag = `"sha256-${asset.sha256}"`
        res.set({
          ETag: tag,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=31536000, immutable, no-transform',
          'Content-Type': asset.mediaType,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="${asset.id}"`
        })
        if (matches(req.get('If-None-Match'), tag)) {
          res.status(304).end()
          return
        }
        let range = { start: 0, end: asset.size - 1 }
        const requested = req.get('Range')
        if (
          requested &&
          (!req.get('If-Range') || req.get('If-Range') === tag)
        ) {
          try {
            range = byteRange(requested, asset.size)
          } catch (error) {
            res.set('Content-Range', `bytes */${asset.size}`)
            throw error
          }
          res
            .status(206)
            .set(
              'Content-Range',
              `bytes ${range.start}-${range.end}/${asset.size}`
            )
        }
        res.set('Content-Length', String(range.end - range.start + 1))
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        await pipeline(
          handle.createReadStream({ ...range, autoClose: false }),
          res
        )
      } finally {
        await opened.release()
      }
    })
  )

  const begin = wrap(async (req, res) => {
    const stage = await getStore().begin(req.body, req.params.id)
    res.status(201).location(`${API_ROOT}/publications/${stage.id}`).json(stage)
  })
  write.post('/publications', body, begin)
  write.post('/datasets/:id/publications', body, begin)
  write.get(
    '/publications/:publication',
    wrap((req, res) => {
      res
        .set('Cache-Control', 'no-store')
        .json(getStore().publication(req.params.publication!))
    })
  )
  write.put(
    '/publications/:publication/assets/:asset',
    wrap(async (req, res) => {
      if (
        req.is('application/octet-stream') !== 'application/octet-stream' ||
        (req.get('Content-Encoding') &&
          req.get('Content-Encoding') !== 'identity')
      )
        throw new ApiError(
          415,
          'RAW_UPLOAD_REQUIRED',
          'Upload unencoded application/octet-stream bytes'
        )
      const stage = getStore().publication(req.params.publication!)
      const expected = stage.declaration.assets.find(
        (a) => a.id === req.params.asset
      )
      if (!expected)
        throw new ApiError(404, 'ASSET_NOT_DECLARED', 'Asset was not declared')
      if (req.get('Content-Length') !== undefined)
        ensure(
          Number(req.get('Content-Length')) === expected.size,
          'Content-Length differs from declared size'
        )
      req.setTimeout(120000, () => req.destroy(new Error('Upload timed out')))
      const asset = await getStore().upload(
        req.params.publication!,
        req.params.asset!,
        req
      )
      res.status(201).json(asset)
    })
  )
  write.post(
    '/publications/:publication/commit',
    wrap(async (req, res) => {
      const store = getStore()
      const record = await store.commit(req.params.publication!)
      res
        .status(201)
        .location(
          `${API_ROOT}/datasets/${record.id}/versions/${record.version}`
        )
        .json(store.resource(record))
    })
  )
  write.delete(
    '/publications/:publication',
    wrap(async (req, res) => {
      await getStore().abort(req.params.publication!)
      res.status(204).end()
    })
  )
  write.delete(
    '/datasets/:id',
    wrap(async (req, res) => {
      await getStore().remove(req.params.id!)
      res.status(204).end()
    })
  )

  // Verified inventory is an explicit assertion from an administrator/indexer,
  // not something an arbitrary readwrite producer may silently claim.
  router.put(
    '/datasets/:id/versions/:version/inventory',
    body,
    wrap(async (req, res) => {
      const value = req.get('If-Match')
      if (!value)
        throw new ApiError(
          428,
          'REVISION_REQUIRED',
          'If-Match with the current dataset ETag is required'
        )
      const store = getStore()
      const record = store.get(req.params.id!, req.params.version!)
      if (value !== etag(store.resource(record)))
        throw new ApiError(
          412,
          'REVISION_CHANGED',
          'Dataset metadata has changed'
        )
      const updated = await store.enrich(
        record.id,
        record.version,
        req.body,
        record.metadataRevision
      )
      json(req, res, store.resource(updated))
    })
  )
  const parserErrors: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    next
  ) => {
    if (res.headersSent) {
      next(error)
      return
    }
    const type =
      error && typeof error === 'object' && 'type' in error
        ? error.type
        : undefined
    if (type === 'entity.too.large' || type === 'entity.parse.failed')
      res.status(type === 'entity.too.large' ? 413 : 400).json({
        code: 'INVALID_JSON',
        message:
          type === 'entity.too.large'
            ? 'JSON body exceeds 2 MiB'
            : 'Invalid JSON body'
      })
    else next(error)
  }
  router.use(parserErrors)
}
