// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import type {
  Path,
  Plugin,
  ServerAPI,
  SKVersion,
  Value
} from '@signalk/server-api'
import { Catalogue } from './storage'
import { listResources } from './discovery'
import { registerRoutes } from './http'
import { ApiError, ensure, object } from './validation'
import { DEFAULT_LIMITS, PLUGIN_ID, RESOURCE_TYPE, type Limits } from './types'
import { openApi } from './openapi'

function createPlugin(app: ServerAPI): Plugin {
  let current: Catalogue | undefined
  let generation = 0
  let starting = Promise.resolve()
  const store = (): Catalogue => {
    if (!current)
      throw new ApiError(503, 'NOT_READY', 'Forecast catalogue is not running')
    return current
  }
  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Forecast Dataset Provider',
    description:
      'Catalogue and immutable original-content access for forecast datasets',
    schema: {
      type: 'object',
      properties: {
        storageDirectory: {
          type: 'string',
          title: 'Storage directory',
          description:
            'Empty uses this plugin’s Signal K data directory. Must support hard links and atomic file rename.',
          default: ''
        },
        maxAssetBytes: {
          type: 'integer',
          title: 'Maximum bytes per asset',
          minimum: 1,
          default: DEFAULT_LIMITS.maxAssetBytes
        },
        maxDatasetBytes: {
          type: 'integer',
          title: 'Maximum bytes per dataset',
          minimum: 1,
          default: DEFAULT_LIMITS.maxDatasetBytes
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
    },
    start(settings) {
      const attempt = ++generation
      starting = (async () => {
        const input = object(settings, 'settings')
        const limits: Limits = { ...DEFAULT_LIMITS }
        for (const key of Object.keys(limits) as (keyof Limits)[]) {
          if (input[key] !== undefined) {
            ensure(
              typeof input[key] === 'number' &&
                Number.isSafeInteger(input[key]) &&
                input[key] > 0,
              `Invalid ${key}`
            )
            limits[key] = input[key]
          }
        }
        ensure(
          input.storageDirectory === undefined ||
            typeof input.storageDirectory === 'string',
          'Invalid storageDirectory'
        )
        const root = input.storageDirectory
          ? path.resolve(input.storageDirectory as string)
          : path.join(app.getDataDirPath(), 'catalogue')
        const candidate = new Catalogue(root, limits, (id, value) => {
          try {
            app.handleMessage(
              PLUGIN_ID,
              {
                updates: [
                  {
                    values: [
                      {
                        path: `resources.${RESOURCE_TYPE}.${id}` as Path,
                        value: value as Value
                      }
                    ]
                  }
                ]
              },
              'v2' as SKVersion
            )
          } catch (error) {
            app.error(
              `Dataset persisted but notification failed: ${String(error)}`
            )
          }
        })
        await candidate.init()
        if (attempt !== generation) {
          await candidate.close()
          return
        }
        current = candidate
        app.registerResourceProvider({
          type: RESOURCE_TYPE,
          methods: {
            listResources: async (query) => listResources(store(), query),
            getResource: async (id, property) => {
              const active = store()
              const result = active.resource(active.get(id))
              if (!property) return result
              let value: unknown = result
              for (const key of property.split('.')) {
                if (
                  ['__proto__', 'constructor', 'prototype'].includes(key) ||
                  value === null ||
                  typeof value !== 'object' ||
                  !Object.prototype.hasOwnProperty.call(value, key)
                )
                  throw new ApiError(
                    404,
                    'PROPERTY_NOT_FOUND',
                    'Resource property not found'
                  )
                value = (value as Record<string, unknown>)[key]
              }
              return { value }
            },
            setResource: async () => {
              throw new ApiError(
                405,
                'PUBLICATION_REQUIRED',
                `Use ${PLUGIN_ID}'s staged publication API for immutable assets`
              )
            },
            deleteResource: async (id) => {
              await store().remove(id, false)
            }
          }
        })
        app.setPluginStatus(
          `Providing ${RESOURCE_TYPE}: ${current.all().length} datasets`
        )
      })().catch((error) => {
        if (attempt === generation) {
          current = undefined
          app.setPluginError('Catalogue startup failed')
          app.error(String(error))
        }
      })
      return starting
    },
    async stop() {
      generation++
      const active = current
      current = undefined
      if (active) await active.close()
      await starting
      app.setPluginStatus('Stopped')
    },
    registerWithRouter(router) {
      registerRoutes(router, store, (message) => app.error(message))
    },
    getOpenApi: () => openApi
  }
  return plugin
}

export = createPlugin
