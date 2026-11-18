// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Catalogue } from './storage'
import { API_ROOT, type Bounds, type Field, type Version } from './types'
import { ApiError, bounds, date, ensure, fields, object } from './validation'

const registryKey = Symbol.for('macjl.forecast-datasets.processors.v1')
const resultTtl = 20 * 60_000
const byteLimit = 1024 ** 3
const pathRoot = API_ROOT + '/requests'
type Selection = { bbox?: Bounds; fields?: Field[]; from?: string; to?: string }
type ActualSelection = {
  messageCount: number
  bounds?: Bounds
  forecastTimes?: string[]
}
type Capability = {
  operation: 'export'
  output: { format: 'grib2'; layout: 'single-file' }
  selectors: string[]
}
interface Processor {
  id: string
  version: string
  capabilities(record: Version): Capability[]
  run(input: {
    selection: Selection
    paths: string[]
    output: string
    maxBytes: number
    signal: AbortSignal
  }): Promise<ActualSelection>
}
interface Result {
  size: number
  sha256: string
  actual: ActualSelection
}
interface Job {
  id: string
  owner: string
  key: string
  state: 'running' | 'complete' | 'failed'
  source: { id: string; version: string }
  processor: { id: string; version: string }
  selection: Selection
  output: string
  expires: number
  readers: number
  result?: Result
  error?: string
}

function processingSelection(value: unknown): Selection {
  const input = object(value, 'export request')
  ensure(
    Object.keys(input).every((key) =>
      ['operation', 'output', 'selection'].includes(key)
    ),
    'Unknown export request option'
  )
  ensure(input.operation === 'export', 'Expected operation export')
  const output = object(input.output, 'export output')
  ensure(
    Object.keys(output).length === 2 &&
      output.format === 'grib2' &&
      output.layout === 'single-file',
    'Expected single-file GRIB2 output'
  )
  const selectors = object(input.selection ?? {}, 'selection')
  ensure(
    Object.keys(selectors).every((key) =>
      ['bbox', 'fields', 'from', 'to'].includes(key)
    ),
    'Unknown export selector'
  )
  const selection: Selection = {}
  if (selectors.bbox !== undefined) {
    const box = bounds(selectors.bbox)
    ensure(
      box[0] < box[2] && box[1] < box[3],
      'Expected a nonempty bounding box that does not cross the antimeridian'
    )
    selection.bbox = box
  }
  if (selectors.fields !== undefined) {
    const requested = fields(selectors.fields)
    ensure(
      requested.length > 0 && requested.length <= 3,
      'Select one to three supported fields'
    )
    for (const field of requested) {
      const wind = ['eastward_wind', 'northward_wind'].includes(field.parameter)
      ensure(
        wind || field.parameter === 'air_pressure_at_mean_sea_level',
        'Supported fields are eastward_wind, northward_wind and air_pressure_at_mean_sea_level'
      )
      ensure(
        !field.level ||
          (wind &&
            field.level.type === 'heightAboveGround' &&
            field.level.value === 10 &&
            field.level.unit === 'm'),
        'Only the 10 m wind level and mean sea-level pressure are supported'
      )
    }
    const names = [...new Set(requested.map((field) => field.parameter))].sort()
    selection.fields = names.map((parameter) =>
      parameter === 'air_pressure_at_mean_sea_level'
        ? { parameter }
        : {
            parameter,
            level: { type: 'heightAboveGround', value: 10, unit: 'm' }
          }
    )
  }
  ensure(
    (selectors.from === undefined) === (selectors.to === undefined),
    'Supply both from and to'
  )
  if (selectors.from !== undefined) {
    ensure(selection.fields, 'A forecast interval requires explicit fields')
    const from = date(selectors.from, 'from')
    const to = date(selectors.to, 'to')
    const hour = 3600_000
    const first = Date.parse(from)
    const last = Date.parse(to)
    ensure(
      first % hour === 0 &&
        last % hour === 0 &&
        last >= first &&
        last - first <= 51 * hour,
      'Choose a forward interval of at most 51 hours on whole UTC hours'
    )
    selection.from = from
    selection.to = to
  }
  return selection
}

export class Processing {
  private readonly controller = new AbortController()
  private readonly jobs = new Map<string, Job>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly activeReaders = new Set<Promise<void>>()
  private timer?: NodeJS.Timeout

  constructor(
    private readonly scope: string,
    private readonly directory: string,
    private readonly log: (message: string) => void
  ) {}

  async init() {
    await fs.rm(this.directory, { recursive: true, force: true })
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.timer = setInterval(() => this.sweep(), 30_000)
    this.timer.unref()
  }

  private get processor(): Processor | undefined {
    return (globalThis as Record<symbol, Map<string, Processor>>)[
      registryKey
    ]?.get(this.scope)
  }

  get available() {
    return Boolean(this.processor)
  }

  capabilities(record: Version) {
    return this.processor?.capabilities(record) ?? []
  }

  describe(job: Job) {
    const href = pathRoot + '/' + job.id
    return {
      id: job.id,
      state: job.state,
      href,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result
        ? {
            result: {
              ...job.result,
              href: href + '/data',
              format: 'grib2',
              expires: new Date(job.expires).toISOString(),
              provenance: {
                source: job.source,
                processor: job.processor,
                selection: job.selection
              }
            }
          }
        : {})
    }
  }

  start(
    owner: string,
    catalogue: Catalogue,
    id: string,
    version: string,
    body: unknown
  ) {
    const processor = this.processor
    if (!processor || this.controller.signal.aborted)
      throw new ApiError(
        503,
        'PROCESSOR_UNAVAILABLE',
        'Enable GRIB Processor and configure its Python runtime'
      )
    const selection = processingSelection(body)
    const record = catalogue.get(id, version)
    const capability = processor.capabilities(record)[0]
    if (
      !capability ||
      Object.keys(selection).some((key) => !capability.selectors.includes(key))
    )
      throw new ApiError(
        422,
        'UNSUPPORTED_SELECTION',
        'This dataset does not support the requested GRIB export selectors'
      )
    if (record.assets.reduce((sum, asset) => sum + asset.size, 0) > byteLimit)
      throw new ApiError(
        413,
        'EXPORT_TOO_LARGE',
        'This prototype accepts at most 1 GiB of source assets'
      )
    this.sweep()
    const key = JSON.stringify([
      owner,
      id,
      version,
      selection,
      processor.id,
      processor.version
    ])
    const previous = [...this.jobs.values()].find(
      (job) =>
        job.key === key && job.state !== 'failed' && job.expires > Date.now()
    )
    if (previous) return previous
    if (this.tasks.size || this.jobs.size >= 4)
      throw new ApiError(
        429,
        'PROCESSING_BUSY',
        'An export is running or the temporary result limit has been reached'
      )
    const inputs = catalogue.processingInputs(id, version)
    const jobId = randomUUID()
    const job: Job = {
      id: jobId,
      owner,
      key,
      state: 'running',
      source: { id, version },
      processor: { id: processor.id, version: processor.version },
      selection,
      readers: 0,
      expires: Infinity,
      output: path.join(this.directory, jobId + '.grib2')
    }
    this.jobs.set(jobId, job)
    const task = this.run(job, processor, inputs).finally(() =>
      this.tasks.delete(task)
    )
    this.tasks.add(task)
    return job
  }

  private async run(
    job: Job,
    processor: Processor,
    inputs: { paths: string[]; release(): void }
  ) {
    try {
      const actual = await processor.run({
        selection: job.selection,
        paths: inputs.paths,
        output: job.output,
        maxBytes: byteLimit,
        signal: this.controller.signal
      })
      const { size } = await fs.stat(job.output)
      ensure(size > 0 && size <= byteLimit, 'Invalid result size')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(job.output, {
        signal: this.controller.signal
      }))
        hash.update(chunk)
      job.result = { size, sha256: hash.digest('hex'), actual }
      job.state = 'complete'
    } catch (error) {
      job.state = 'failed'
      const workerError = (error as { stderr?: unknown })?.stderr
      const safe = typeof workerError === 'string' ? workerError.trim() : ''
      job.error = /^[\w ,.;:'-]{1,220}$/.test(safe)
        ? safe
        : 'GRIB generation failed'
      if (!this.controller.signal.aborted) this.log(job.error)
      await fs
        .rm(job.output, { force: true })
        .catch(() => this.log('Failed to remove incomplete GRIB export'))
    } finally {
      inputs.release()
      job.expires = Date.now() + (job.state === 'complete' ? resultTtl : 60_000)
    }
  }

  get(owner: string, id: string): Job {
    const job = this.jobs.get(id)
    if (
      !job ||
      job.owner !== owner ||
      job.expires <= Date.now() ||
      this.controller.signal.aborted
    )
      throw new ApiError(
        404,
        'REQUEST_NOT_FOUND',
        'Export request not found or expired'
      )
    return job
  }

  async open(owner: string, id: string) {
    const job = this.get(owner, id)
    if (!job.result)
      throw new ApiError(
        409,
        'RESULT_UNAVAILABLE',
        'Export result is not ready'
      )
    job.readers++
    let releaseReader!: () => void
    const finished = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    this.activeReaders.add(finished)
    const release = () => {
      job.readers--
      this.activeReaders.delete(finished)
      releaseReader()
    }
    try {
      const handle = await fs.open(job.output, 'r')
      return {
        handle,
        result: job.result,
        release: () => handle.close().finally(release)
      }
    } catch (error) {
      release()
      throw error
    }
  }

  private sweep() {
    for (const job of this.jobs.values()) {
      if (job.expires > Date.now() || job.readers) continue
      // Keep its slot until the file has been removed.
      if (job.expires === -Infinity) continue
      job.expires = -Infinity
      void fs
        .rm(job.output, { force: true })
        .then(() => this.jobs.delete(job.id))
        .catch(() => {
          job.expires = 0
          this.log('Failed to clean temporary GRIB export')
        })
    }
  }

  async close() {
    clearInterval(this.timer)
    this.controller.abort()
    await Promise.all([...this.tasks, ...this.activeReaders])
    await fs.rm(this.directory, { recursive: true, force: true })
  }
}
