// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { canonical, type Catalogue } from './storage'
import { API_ROOT, type Bounds, type Field, type Version } from './types'
import {
  ApiError,
  bounds,
  date,
  ensure,
  expirySeconds,
  fields,
  object
} from './validation'

const registryKey = Symbol.for('macjl.forecast-datasets.processors.v1')
const jobTtl = 20 * 60_000
const defaultLifetime = 20 * 60
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
  fields?: Field[]
  forecastInterval?: { stepSeconds: number; maxHours: number }
}
// Older providers require a list of fields and a fixed forecast grid.
const supportedSelectors = { timeRanges: true, unlistedFields: true } as const
interface Processor {
  id: string
  version: string
  capabilities(
    record: Version,
    support: typeof supportedSelectors
  ): Capability[]
  run(input: {
    selection: Selection
    paths: string[]
    output: string
    maxBytes: number
    signal: AbortSignal
  }): Promise<ActualSelection>
  analyze?(input: { paths: string[]; signal: AbortSignal }): Promise<{
    run?: string
    forecastTimes: string[]
  }>
}
interface Result {
  dataset: Version
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
  lifetime: number | null
  result?: Result
  error?: string
}

function processingRequest(
  value: unknown,
  capability: Capability
): {
  selection: Selection
  lifetime: number | null
} {
  const input = object(value === undefined ? {} : value, 'export request')
  ensure(
    Object.keys(input).every((key) =>
      ['operation', 'output', 'selection', 'expiresInSeconds'].includes(key)
    ),
    'Unknown export request option'
  )
  ensure(
    input.operation === undefined || input.operation === capability.operation,
    'Expected operation export'
  )
  if (input.output !== undefined) {
    const output = object(input.output, 'export output')
    ensure(
      Object.keys(output).length === 2 &&
        output.format === capability.output.format &&
        output.layout === capability.output.layout,
      'Expected single-file GRIB2 output'
    )
  }
  const selectors = object(
    input.selection === undefined ? {} : input.selection,
    'selection'
  )
  ensure(
    Object.keys(selectors).every((key) =>
      ['bbox', 'fields', 'from', 'to'].includes(key)
    ),
    'Unknown export selector'
  )
  if (Object.keys(selectors).some((key) => !capability.selectors.includes(key)))
    throw new ApiError(
      422,
      'UNSUPPORTED_SELECTION',
      'The dataset does not support the requested selectors'
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
    const wanted = fields(selectors.fields)
    ensure(wanted.length > 0, 'Select at least one field')
    const selected = new Map<string, Field>()
    for (let field of wanted) {
      if (capability.fields?.length) {
        const matches = capability.fields.filter(
          (candidate) =>
            candidate.parameter === field.parameter &&
            (!field.level ||
              (field.level.type === candidate.level?.type &&
                field.level.value === candidate.level.value &&
                (!field.level.unit ||
                  field.level.unit === candidate.level.unit)))
        )
        if (matches.length !== 1)
          throw new ApiError(
            422,
            'UNSUPPORTED_FIELD',
            'Choose one of the parameter and level pairs advertised for this dataset'
          )
        field = matches[0]!
      }
      selected.set(canonical(field), field)
    }
    selection.fields = [...selected.keys()]
      .sort()
      .map((key) => selected.get(key)!)
  }
  ensure(
    (selectors.from === undefined) === (selectors.to === undefined),
    'Supply both from and to'
  )
  if (selectors.from !== undefined) {
    const from = date(selectors.from, 'from')
    const to = date(selectors.to, 'to')
    ensure(from <= to, 'from must not follow to')
    const interval = capability.forecastInterval
    if (interval) {
      ensure(selection.fields, 'This export profile requires explicit fields')
      const step = interval.stepSeconds * 1000
      const first = Date.parse(from)
      const last = Date.parse(to)
      ensure(
        first % step === 0 &&
          last % step === 0 &&
          last - first <= interval.maxHours * 3600_000,
        `Choose a forward interval of at most ${interval.maxHours} hours aligned to ${interval.stepSeconds}-second UTC steps`
      )
    }
    selection.from = from
    selection.to = to
  }
  const lifetime =
    input.expiresInSeconds === null
      ? null
      : expirySeconds(input.expiresInSeconds ?? defaultLifetime)
  return { selection, lifetime }
}

export class Processing {
  private readonly controller = new AbortController()
  private readonly jobs = new Map<string, Job>()
  private readonly tasks = new Set<Promise<void>>()
  private timer?: NodeJS.Timeout
  private analysisTask?: Promise<void>
  private readonly analysisRetry = new Map<string, number>()

  constructor(
    private readonly scope: string,
    private readonly directory: string,
    private readonly log: (message: string) => void
  ) {}

  async init(catalogue: Catalogue) {
    await fs.rm(this.directory, { recursive: true, force: true })
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const tick = () => {
      this.sweep()
      this.scheduleAnalysis(catalogue)
    }
    this.timer = setInterval(tick, 5_000)
    this.timer.unref()
    tick()
  }

  private scheduleAnalysis(catalogue: Catalogue) {
    const processor = this.processor
    if (
      !processor?.analyze ||
      this.analysisTask ||
      this.tasks.size ||
      this.controller.signal.aborted
    )
      return
    const candidates = catalogue.all().filter(
      (record) =>
        record.format === 'grib2' &&
        record.kind !== 'harmonic' &&
        !record.inventory?.metadata.forecast?.times?.length &&
        // Short-lived exports are delivered directly to the requesting client.
        !(record.expiresAt && record.producer === processor.id)
    )
    const key = (record: Version) => record.id + ':' + record.version
    const current = new Set(candidates.map(key))
    for (const prior of this.analysisRetry.keys())
      if (!current.has(prior)) this.analysisRetry.delete(prior)
    const now = Date.now()
    const record = candidates
      .filter((item) => (this.analysisRetry.get(key(item)) ?? 0) <= now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (!record) return
    this.analysisTask = this.analyze(
      catalogue,
      record,
      processor.analyze.bind(processor)
    )
      .catch((error) => {
        if (this.controller.signal.aborted) return
        this.analysisRetry.set(key(record), Date.now() + 5 * 60_000)
        if (!(
          error instanceof ApiError && [404, 409, 412].includes(error.status)
        ))
          this.log(
            `Could not analyze GRIB2 dataset ${record.id}: ${String(error.message ?? error)}`
          )
      })
      .finally(() => {
        this.analysisTask = undefined
        this.scheduleAnalysis(catalogue)
      })
  }

  private async analyze(
    catalogue: Catalogue,
    record: Version,
    analyze: NonNullable<Processor['analyze']>
  ) {
    const inputs = catalogue.processingInputs(record.id, record.version)
    try {
      const existing = record.inventory
        ? (await catalogue.readInventory(record.id, record.version)).inventory
        : { metadata: {}, index: {} }
      const { run, forecastTimes: times } = await analyze({
        paths: inputs.paths,
        signal: this.controller.signal
      })
      this.controller.signal.throwIfAborted()
      await catalogue.enrich(
        record.id,
        record.version,
        {
          metadata: {
            ...existing.metadata,
            ...(run ? { run } : {}),
            forecast: { from: times[0], to: times.at(-1), times }
          },
          index: existing.index
        },
        record.metadataRevision
      )
    } finally {
      inputs.release()
    }
  }

  private get processor(): Processor | undefined {
    return (globalThis as Record<symbol, Map<string, Processor>>)[
      registryKey
    ]?.get(this.scope)
  }

  get available() {
    return Boolean(this.processor)
  }

  capabilities(record: Version, outputLimit = byteLimit) {
    if (record.assets.reduce((sum, asset) => sum + asset.size, 0) > byteLimit)
      return []
    return (this.processor?.capabilities(record, supportedSelectors) ?? []).map(
      (capability) => ({
        ...capability,
        href: `${API_ROOT}/datasets/${record.id}/versions/${record.version}/requests`,
        maxInputBytes: byteLimit,
        maxOutputBytes: Math.min(byteLimit, outputLimit)
      })
    )
  }

  describe(job: Job, catalogue: Catalogue) {
    const href = pathRoot + '/' + job.id
    const output = job.result
    if (output) {
      try {
        catalogue.get(output.dataset.id, output.dataset.version)
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'DATASET_NOT_FOUND'))
          throw error
        return { id: job.id, state: 'expired', href }
      }
    }
    return {
      id: job.id,
      state: job.state,
      href,
      ...(job.error ? { error: job.error } : {}),
      ...(output
        ? {
            result: {
              ...catalogue.resource(output.dataset),
              href: `${API_ROOT}/datasets/${output.dataset.id}/versions/${output.dataset.version}`,
              actual: output.actual
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
        'Enable GRIB Processor on the catalogue server'
      )
    const record = catalogue.get(id, version)
    const capability = processor
      .capabilities(record, supportedSelectors)
      .find((item) => item.operation === 'export')
    if (!capability)
      throw new ApiError(
        422,
        'UNSUPPORTED_SELECTION',
        'The dataset does not support GRIB export'
      )
    if (record.assets.reduce((sum, asset) => sum + asset.size, 0) > byteLimit)
      throw new ApiError(
        413,
        'EXPORT_TOO_LARGE',
        'This prototype accepts at most 1 GiB of source assets'
      )
    const { selection, lifetime } = processingRequest(body, capability)
    this.sweep()
    const key = JSON.stringify([
      owner,
      id,
      version,
      selection,
      lifetime,
      processor.id,
      processor.version
    ])
    const previous = [...this.jobs.values()].find(
      (job) =>
        job.key === key && job.state !== 'failed' && job.expires > Date.now()
    )
    if (previous) {
      if (!previous.result) return previous
      try {
        catalogue.get(
          previous.result.dataset.id,
          previous.result.dataset.version
        )
        return previous
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'DATASET_NOT_FOUND'))
          throw error
        this.jobs.delete(previous.id)
      }
    }
    if (this.tasks.size)
      throw new ApiError(429, 'PROCESSING_BUSY', 'An export is already running')
    if (this.jobs.size >= 128) {
      const oldest = this.jobs.keys().next().value
      if (oldest) this.jobs.delete(oldest)
    }
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
      lifetime,
      expires: Infinity,
      output: path.join(this.directory, jobId + '.grib2')
    }
    this.jobs.set(jobId, job)
    const task = this.run(job, processor, catalogue, record, inputs).finally(
      () => this.tasks.delete(task)
    )
    this.tasks.add(task)
    return job
  }

  private async run(
    job: Job,
    processor: Processor,
    catalogue: Catalogue,
    record: Version,
    inputs: { paths: string[]; release(): void }
  ) {
    let publication: string | undefined
    try {
      const maxBytes = Math.min(
        byteLimit,
        catalogue.limits.maxAssetBytes,
        catalogue.limits.maxDatasetBytes
      )
      const actual = await processor.run({
        selection: job.selection,
        paths: inputs.paths,
        output: job.output,
        maxBytes,
        signal: this.controller.signal
      })
      const { size } = await fs.stat(job.output)
      ensure(size > 0 && size <= maxBytes, 'Invalid result size')
      this.controller.signal.throwIfAborted()
      const sourceMetadata = {
        ...record.metadata,
        ...record.inventory?.metadata
      }
      const times = actual.forecastTimes
      const metadata = {
        name: `${sourceMetadata.name ?? sourceMetadata.model ?? 'Forecast'} export`.slice(
          0,
          512
        ),
        model: sourceMetadata.model,
        run: sourceMetadata.run,
        bounds: job.selection.bbox ? actual.bounds : sourceMetadata.bounds,
        fields: job.selection.fields ?? sourceMetadata.fields,
        forecast: times?.length
          ? { from: times[0], to: times[times.length - 1] }
          : job.selection.from
            ? undefined
            : sourceMetadata.forecast && {
                from: sourceMetadata.forecast.from,
                to: sourceMetadata.forecast.to
              }
      }
      // Use the public publication rules, quotas and notification path.
      const stage = await catalogue.begin({
        kind: record.kind,
        format: 'grib2',
        producer: processor.id,
        metadata,
        ...(job.lifetime === null ? {} : { expiresInSeconds: job.lifetime }),
        provenance: {
          source: job.source,
          processor: job.processor,
          selection: job.selection
        },
        assets: [{ id: 'forecast_grib2', size }]
      })
      publication = stage.id
      await catalogue.upload(stage.id, 'forecast_grib2', {
        preparedPath: job.output,
        signal: this.controller.signal
      })
      this.controller.signal.throwIfAborted()
      const dataset = await catalogue.commit(stage.id)
      publication = undefined
      job.result = { dataset, actual }
      job.state = 'complete'
    } catch (error) {
      job.state = 'failed'
      const workerError = (error as { stderr?: unknown })?.stderr
      const safe = typeof workerError === 'string' ? workerError.trim() : ''
      job.error =
        error instanceof ApiError
          ? error.message
          : /^[\w ,.;:'-]{1,220}$/.test(safe)
            ? safe
            : 'GRIB generation failed'
      if (!this.controller.signal.aborted) this.log(job.error)
      if (publication)
        await catalogue
          .abort(publication)
          .catch(() => this.log('Could not abort GRIB publication'))
    } finally {
      inputs.release()
      await fs
        .rm(job.output, { force: true })
        .catch(() => this.log('Could not remove the GRIB worker file'))
      job.expires = Date.now() + (job.state === 'complete' ? jobTtl : 60_000)
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

  private sweep() {
    for (const job of this.jobs.values())
      if (job.expires <= Date.now()) this.jobs.delete(job.id)
  }

  async close() {
    clearInterval(this.timer)
    this.controller.abort()
    await this.analysisTask
    await Promise.all(this.tasks)
    await fs.rm(this.directory, { recursive: true, force: true })
  }
}
