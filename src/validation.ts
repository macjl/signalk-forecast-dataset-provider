// SPDX-License-Identifier: Apache-2.0
import type {
  Bounds,
  Declaration,
  Field,
  Inventory,
  JsonObject,
  Limits,
  Metadata
} from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ApiError(400, 'INVALID_REQUEST', message)
}
export function object(value: unknown, label: string): Record<string, unknown> {
  ensure(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`
  )
  return value as Record<string, unknown>
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string
) {
  for (const key of Object.keys(value))
    ensure(allowed.includes(key), `Unknown ${label} property: ${key}`)
}
export function text(value: unknown, label: string, max = 512): string {
  ensure(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f\x7f]/.test(value),
    `${label} must be a non-empty string (max ${max}) without control characters`
  )
  return value
}
export function identifier(value: unknown): string {
  ensure(
    typeof value === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value),
    'Invalid identifier'
  )
  ensure(
    !['__proto__', 'constructor', 'prototype'].includes(value),
    'Reserved identifier'
  )
  return value
}
export function date(value: unknown, label: string): string {
  const result = text(value, label)
  ensure(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result) &&
      Number.isFinite(Date.parse(result)),
    `${label} must be a UTC ISO timestamp`
  )
  const normalized = new Date(result).toISOString()
  ensure(
    normalized.slice(0, 19) === result.slice(0, 19),
    `${label} is not a valid calendar date`
  )
  return normalized
}
export function bounds(value: unknown): Bounds {
  if (typeof value === 'string')
    ensure(
      value.split(',').every((part) => part.trim().length > 0),
      'Empty bounds coordinate'
    )
  const data = typeof value === 'string' ? value.split(',').map(Number) : value
  ensure(
    Array.isArray(data) &&
      data.length === 4 &&
      data.every((n) => typeof n === 'number' && Number.isFinite(n)),
    'bounds must be [west,south,east,north]'
  )
  const [w, s, e, n] = data as Bounds
  ensure(
    w >= -180 &&
      w <= 180 &&
      e >= -180 &&
      e <= 180 &&
      s >= -90 &&
      n <= 90 &&
      s <= n,
    'Invalid WGS84 bounds'
  )
  return [w, s, e, n]
}
function jsonObject(value: unknown, label: string): JsonObject {
  const result = object(value, label)
  const visit = (v: unknown, depth: number): void => {
    ensure(depth <= 20, `${label} exceeds nesting limit`)
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return
    if (typeof v === 'number') {
      ensure(Number.isFinite(v), 'Non-finite JSON number')
      return
    }
    ensure(typeof v === 'object', `${label} must contain JSON values`)
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1))
      return
    }
    for (const [key, item] of Object.entries(v as object)) {
      ensure(
        !['__proto__', 'constructor', 'prototype'].includes(key),
        'Reserved JSON property'
      )
      visit(item, depth + 1)
    }
  }
  visit(result, 0)
  return JSON.parse(JSON.stringify(result)) as JsonObject
}
export function fields(value: unknown): Field[] {
  ensure(
    Array.isArray(value) && value.length <= 10000,
    'fields must be an array (max 10000)'
  )
  return value.map((item) => {
    const f = object(item, 'field')
    keys(f, ['parameter', 'level'], 'field')
    const field: Field = { parameter: text(f.parameter, 'parameter') }
    if (f.level !== undefined) {
      const l = object(f.level, 'level')
      keys(l, ['type', 'value', 'unit'], 'level')
      ensure(
        typeof l.value === 'number' && Number.isFinite(l.value),
        'level.value must be a finite number'
      )
      field.level = { type: text(l.type, 'level.type'), value: l.value }
      if (l.unit !== undefined)
        field.level.unit = text(l.unit, 'level.unit', 32)
    }
    return field
  })
}
export function metadata(value: unknown): Metadata {
  const input = object(value, 'metadata')
  keys(
    input,
    [
      'name',
      'description',
      'model',
      'run',
      'bounds',
      'forecast',
      'fields',
      'grid'
    ],
    'metadata'
  )
  const out: Metadata = {}
  for (const key of ['name', 'description', 'model'] as const)
    if (input[key] !== undefined)
      out[key] = text(input[key], key, key === 'description' ? 4096 : 512)
  if (input.run !== undefined) out.run = date(input.run, 'run')
  if (input.bounds !== undefined) out.bounds = bounds(input.bounds)
  if (input.forecast !== undefined) {
    const f = object(input.forecast, 'forecast')
    keys(f, ['from', 'to'], 'forecast')
    out.forecast = { from: date(f.from, 'from'), to: date(f.to, 'to') }
    ensure(
      out.forecast.from <= out.forecast.to,
      'forecast.from must not follow forecast.to'
    )
  }
  if (input.fields !== undefined) out.fields = fields(input.fields)
  if (input.grid !== undefined) out.grid = jsonObject(input.grid, 'grid')
  return out
}
export function declaration(value: unknown, limits: Limits): Declaration {
  const input = object(value, 'publication')
  keys(
    input,
    [
      'kind',
      'format',
      'producer',
      'metadata',
      'requested',
      'provenance',
      'assets'
    ],
    'publication'
  )
  ensure(
    ['forecast', 'analysis', 'harmonic'].includes(input.kind as string),
    'Invalid kind'
  )
  const format = text(input.format, 'format', 64)
  ensure(
    /^[a-z0-9][a-z0-9_-]*$/.test(format),
    'format must be a lowercase format identifier'
  )
  ensure(
    Array.isArray(input.assets) &&
      input.assets.length > 0 &&
      input.assets.length <= limits.maxAssets,
    'Invalid asset count'
  )
  const assets = input.assets.map((item) => {
    const a = object(item, 'asset')
    keys(a, ['id', 'size', 'sha256', 'mediaType'], 'asset')
    const id = identifier(a.id)
    const asset: Declaration['assets'][number] = { id }
    if (a.size !== undefined) {
      ensure(
        typeof a.size === 'number' &&
          Number.isSafeInteger(a.size) &&
          a.size > 0 &&
          a.size <= limits.maxAssetBytes,
        'Invalid asset size'
      )
      asset.size = a.size
    }
    if (a.sha256 !== undefined) {
      ensure(
        typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256),
        'Invalid sha256'
      )
      asset.sha256 = a.sha256
    }
    if (a.mediaType !== undefined) {
      const mt = text(a.mediaType, 'mediaType', 128)
      ensure(/^[\w.+-]+\/[\w.+-]+$/.test(mt), 'Invalid mediaType')
      asset.mediaType = mt
    }
    return asset
  })
  ensure(
    new Set(assets.map((a) => a.id.toLowerCase())).size === assets.length,
    'Duplicate or case-colliding asset identifiers'
  )
  ensure(
    assets.reduce((n, a) => n + (a.size ?? 0), 0) <= limits.maxDatasetBytes,
    'Dataset exceeds configured size limit'
  )
  const result: Declaration = {
    kind: input.kind as Declaration['kind'],
    format,
    producer: text(input.producer, 'producer'),
    metadata: metadata(input.metadata ?? {}),
    assets
  }
  if (input.requested !== undefined)
    result.requested = jsonObject(input.requested, 'requested')
  if (input.provenance !== undefined)
    result.provenance = jsonObject(input.provenance, 'provenance')
  return result
}
export function inventory(value: unknown): Inventory {
  const input = object(value, 'inventory')
  keys(input, ['metadata', 'index'], 'inventory')
  return {
    metadata: metadata(input.metadata),
    index: jsonObject(input.index, 'index')
  }
}
