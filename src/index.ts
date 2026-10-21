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
import { ApiError } from './validation'
import { PLUGIN_ID, RESOURCE_TYPE } from './types'
import { openApi } from './openapi'
import { parseSettings, settingsSchema } from './settings'

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
    schema: settingsSchema(),
    start(settings) {
      const attempt = ++generation
      starting = (async () => {
        const { limits, configuration: input } = parseSettings(settings)
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
