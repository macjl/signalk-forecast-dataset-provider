// SPDX-License-Identifier: Apache-2.0
import { Readable } from 'node:stream'
import { listResources } from './discovery'
import type { Catalogue } from './storage'
import { CONTRACT_VERSION } from './types'

const key = Symbol.for('macjl.forecast-datasets.catalogues.v1')
const registries = globalThis as typeof globalThis & {
  [key]?: Map<string, ReturnType<typeof localCatalogue>>
}

function localCatalogue(store: Catalogue, lifetime: AbortSignal) {
  return {
    contractVersion: CONTRACT_VERSION,
    publications: () => store.publications(),
    publication: (id: string) => store.publication(id),
    begin: (declaration: unknown) => store.begin(declaration),
    upload: (id: string, asset: string, body: Readable, signal: AbortSignal) =>
      store.upload(id, asset, body, AbortSignal.any([lifetime, signal])),
    commit: async (id: string) => store.resource(await store.commit(id)),
    abort: (id: string) => store.abort(id),
    datasets: (query: Record<string, unknown>) =>
      structuredClone(listResources(store, query)),
    dataset: (id: string, version?: string) =>
      structuredClone(store.resource(store.get(id, version))),
    remove: (id: string) => store.remove(id),
    readAsset(id: string, version: string, asset: string, signal: AbortSignal) {
      const active = AbortSignal.any([lifetime, signal])
      return Readable.from(
        (async function* () {
          active.throwIfAborted()
          const opened = await store.openAsset(id, version, asset)
          try {
            yield* opened.handle.createReadStream({
              autoClose: false,
              signal: active
            })
          } finally {
            await opened.release()
          }
        })(),
        { objectMode: false }
      )
    }
  }
}

export function registerLocalCatalogue(scope: string, store: Catalogue) {
  const registry = (registries[key] ??= new Map())
  const lifetime = new AbortController()
  const service = localCatalogue(store, lifetime.signal)
  registry.set(scope, service)
  return () => {
    if (registry.get(scope) === service) registry.delete(scope)
    lifetime.abort(new Error('Local Forecast Dataset Provider stopped'))
  }
}
