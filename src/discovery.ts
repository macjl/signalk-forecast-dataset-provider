// SPDX-License-Identifier: Apache-2.0
import type { Bounds, Field, Version } from './types'
import { Catalogue } from './storage'
import { bounds, date, ensure, fields, text } from './validation'

function longitudeIntervals(box: Bounds): [number, number][] {
  return box[0] <= box[2]
    ? [[box[0], box[2]]]
    : [
        [box[0], 180],
        [-180, box[2]]
      ]
}
function matchesBox(actual: Bounds, wanted: Bounds, overlap: boolean): boolean {
  if (overlap)
    return (
      actual[1] <= wanted[3] &&
      actual[3] >= wanted[1] &&
      longitudeIntervals(actual).some((a) =>
        longitudeIntervals(wanted).some((w) => a[0] <= w[1] && a[1] >= w[0])
      )
    )
  return (
    actual[1] <= wanted[1] &&
    actual[3] >= wanted[3] &&
    longitudeIntervals(wanted).every((w) =>
      longitudeIntervals(actual).some((a) => a[0] <= w[0] && a[1] >= w[1])
    )
  )
}
function fieldMatches(actual: Field, wanted: Field): boolean {
  return (
    actual.parameter === wanted.parameter &&
    (!wanted.level ||
      (actual.level?.type === wanted.level.type &&
        actual.level.value === wanted.level.value &&
        actual.level.unit === wanted.level.unit))
  )
}

/** Coverage/field predicates only use inventory supplied by a trusted indexer. */
export function listResources(
  store: Catalogue,
  query: Record<string, unknown>
): Record<string, unknown> {
  const supported = [
    'provider',
    'model',
    'format',
    'kind',
    'producer',
    'state',
    'verified',
    'bbox',
    'from',
    'to',
    'coverage',
    'fields',
    'sort',
    'limit',
    'offset'
  ]
  for (const key of Object.keys(query))
    ensure(supported.includes(key), `Unknown discovery filter: ${key}`)
  for (const key of ['model', 'format', 'kind', 'producer'] as const)
    if (query[key] !== undefined) text(query[key], key)
  ensure(
    query.state === undefined || query.state === 'complete',
    'Only state=complete is supported; unfinished content is private staging'
  )
  ensure(
    query.verified === undefined ||
      [true, false, 'true', 'false'].includes(query.verified as boolean),
    'verified must be true or false'
  )
  ensure(
    query.coverage === undefined ||
      ['contains', 'overlaps'].includes(query.coverage as string),
    'coverage must be contains or overlaps'
  )
  ensure(
    query.sort === undefined ||
      ['run', 'createdAt'].includes(query.sort as string),
    'sort must be run or createdAt'
  )
  const limit = query.limit === undefined ? 100 : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)
  ensure(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
    'limit must be 1..1000'
  )
  ensure(
    Number.isSafeInteger(offset) && offset >= 0,
    'offset must be a non-negative integer'
  )
  const box = query.bbox === undefined ? undefined : bounds(query.bbox)
  const from = query.from === undefined ? undefined : date(query.from, 'from')
  const to = query.to === undefined ? undefined : date(query.to, 'to')
  ensure(!from || !to || from <= to, 'from must not follow to')
  let wanted: Field[] | undefined
  if (query.fields !== undefined) {
    let raw = query.fields
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch {
        ensure(false, 'fields must be a JSON array')
      }
    }
    wanted = fields(raw)
  }
  const overlap = query.coverage === 'overlaps'
  const filtered = store.all().filter((record) => {
    const info = { ...record.metadata, ...record.inventory?.metadata }
    for (const key of ['format', 'kind', 'producer'] as const)
      if (query[key] !== undefined && record[key] !== query[key]) return false
    if (query.model !== undefined && info.model !== query.model) return false
    if (
      query.verified !== undefined &&
      Boolean(record.inventory) !==
        (query.verified === true || query.verified === 'true')
    )
      return false
    const verified = record.inventory?.metadata
    if (
      box &&
      (!verified?.bounds || !matchesBox(verified.bounds, box, overlap))
    )
      return false
    if (from || to) {
      if (!verified?.forecast) return false
      const actual = verified.forecast
      if (
        overlap
          ? (from && actual.to < from) || (to && actual.from > to)
          : (from && actual.from > from) || (to && actual.to < to)
      )
        return false
    }
    if (
      wanted?.length &&
      (!verified?.fields ||
        !wanted.every((w) => verified.fields!.some((a) => fieldMatches(a, w))))
    )
      return false
    return true
  })
  const time = (record: Version) =>
    query.sort === 'createdAt'
      ? record.createdAt
      : (record.inventory?.metadata.run ?? record.metadata.run ?? '')
  filtered.sort(
    (a, b) =>
      time(b).localeCompare(time(a)) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id)
  )
  return Object.fromEntries(
    filtered
      .slice(offset, offset + limit)
      .map((r) => [r.id, store.resource(r, true)])
  )
}
