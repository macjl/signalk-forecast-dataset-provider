// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_LIMITS, type Limits } from './types'
import { ensure, object } from './validation'

export const BYTES_PER_MIB = 1024 ** 2
const sizeOptions = [
  ['maxAssetMiB', 'maxAssetBytes'],
  ['maxDatasetMiB', 'maxDatasetBytes']
] as const

export function parseSettings(value: unknown): {
  limits: Limits
  configuration: Record<string, unknown>
} {
  const input = object(value, 'settings')
  const limits = { ...DEFAULT_LIMITS }
  for (const [display, internal] of sizeOptions) {
    if (input[display] !== undefined) {
      const amount = input[display]
      ensure(
        typeof amount === 'number' && Number.isFinite(amount) && amount > 0,
        `Invalid ${display}`
      )
      const bytes = Math.floor(amount * BYTES_PER_MIB)
      ensure(Number.isSafeInteger(bytes) && bytes > 0, `Invalid ${display}`)
      limits[internal] = bytes
    }
  }
  for (const key of ['maxAssets', 'maxStaging'] as const) {
    const amount = input[key]
    if (amount !== undefined) {
      ensure(
        typeof amount === 'number' &&
          Number.isSafeInteger(amount) &&
          amount > 0,
        `Invalid ${key}`
      )
      limits[key] = amount
    }
  }
  ensure(
    input.storageDirectory === undefined ||
      typeof input.storageDirectory === 'string',
    'Invalid storageDirectory'
  )
  return { limits, configuration: input }
}

export function settingsSchema(): object {
  return {
    type: 'object',
    properties: {
      storageDirectory: {
        type: 'string',
        title: 'Storage directory',
        description:
          'Empty uses this plugin’s Signal K data directory. Must support hard links and atomic file rename.',
        default: ''
      },
      maxAssetMiB: {
        type: 'number',
        title: 'Maximum size per asset (MiB)',
        description:
          '1 MiB = 1,048,576 bytes. Decimal values are allowed; the byte limit is rounded down.',
        minimum: 1 / BYTES_PER_MIB,
        maximum: Number.MAX_SAFE_INTEGER / BYTES_PER_MIB,
        default: DEFAULT_LIMITS.maxAssetBytes / BYTES_PER_MIB
      },
      maxDatasetMiB: {
        type: 'number',
        title: 'Maximum size per publication (MiB)',
        description:
          'Combined size of all assets in one publication, not a global disk quota. 1 MiB = 1,048,576 bytes.',
        minimum: 1 / BYTES_PER_MIB,
        maximum: Number.MAX_SAFE_INTEGER / BYTES_PER_MIB,
        default: DEFAULT_LIMITS.maxDatasetBytes / BYTES_PER_MIB
      },
      maxAssets: {
        type: 'integer',
        title: 'Maximum assets per publication',
        minimum: 1,
        default: DEFAULT_LIMITS.maxAssets
      },
      maxStaging: {
        type: 'integer',
        title: 'Maximum unfinished publications',
        minimum: 1,
        default: DEFAULT_LIMITS.maxStaging
      }
    }
  }
}
