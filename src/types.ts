// SPDX-License-Identifier: Apache-2.0
export const PLUGIN_ID = 'signalk-forecast-dataset-provider'
export const RESOURCE_TYPE = 'forecastDatasets'
export const API_ROOT = `/plugins/${PLUGIN_ID}`
export const CONTRACT_VERSION = '0.1'

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export type Bounds = [number, number, number, number]
export interface Field {
  parameter: string
  level?: { type: string; value: number; unit?: string }
}
export interface Metadata {
  name?: string
  description?: string
  model?: string
  run?: string
  bounds?: Bounds
  forecast?: { from: string; to: string }
  fields?: Field[]
  grid?: JsonObject
}
export interface Declaration {
  kind: 'forecast' | 'analysis' | 'harmonic'
  format: string
  producer: string
  metadata: Metadata
  requested?: JsonObject
  provenance?: JsonObject
  assets: { id: string; size: number; sha256?: string; mediaType?: string }[]
}
export interface Asset {
  id: string
  size: number
  sha256: string
  mediaType: string
}
export interface Inventory {
  metadata: Metadata
  index: JsonObject
}
export interface Version {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  version: string
  kind: Declaration['kind']
  format: string
  producer: string
  state: 'complete'
  createdAt: string
  metadataRevision: number
  metadata: Metadata
  requested?: JsonObject
  provenance?: JsonObject
  assets: Asset[]
  inventory?: { metadata: Metadata; indexHash: string }
}
export interface Staging {
  id: string
  datasetId: string
  createdAt: string
  declaration: Declaration
  uploaded: Record<string, Asset>
}
export interface Limits {
  maxAssetBytes: number
  maxDatasetBytes: number
  maxAssets: number
  maxStaging: number
}
export const DEFAULT_LIMITS: Limits = {
  maxAssetBytes: 2 * 1024 ** 3,
  maxDatasetBytes: 8 * 1024 ** 3,
  maxAssets: 1024,
  maxStaging: 16
}
