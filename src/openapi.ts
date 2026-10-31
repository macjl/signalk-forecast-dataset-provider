// SPDX-License-Identifier: Apache-2.0
import { API_ROOT } from './types'

const id = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}
const version = {
  name: 'version',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-f0-9]{64}$' }
}
const publication = {
  name: 'publication',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' }
}
const asset = {
  name: 'asset',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}
const ok = {
  description:
    'Successful response; see docs/contract-v0.1.md for shapes and semantics'
}
const errors = {
  '400': { description: 'Invalid input' },
  '404': { description: 'Not found' },
  '409': { description: 'Incomplete publication or dataset in use' },
  '503': { description: 'Plugin not running' }
}
const jsonBody = (schema: object) => ({
  required: true,
  content: { 'application/json': { schema } }
})
const metadata = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    model: { type: 'string' },
    run: { type: 'string', format: 'date-time' },
    bounds: {
      type: 'array',
      items: { type: 'number' },
      minItems: 4,
      maxItems: 4
    },
    forecast: {
      type: 'object',
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' }
      }
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['parameter'],
        properties: {
          parameter: { type: 'string' },
          level: {
            type: 'object',
            required: ['type', 'value'],
            properties: {
              type: { type: 'string' },
              value: { type: 'number' },
              unit: { type: 'string' }
            }
          }
        }
      }
    },
    grid: { type: 'object' }
  }
}
const declaration = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'format', 'producer', 'assets'],
  properties: {
    kind: { type: 'string', enum: ['forecast', 'analysis', 'harmonic'] },
    format: { type: 'string' },
    producer: { type: 'string' },
    metadata,
    requested: { type: 'object' },
    provenance: { type: 'object' },
    assets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          size: {
            type: 'integer',
            minimum: 1,
            description:
              'Optional exact expected byte length; measured during upload when omitted'
          },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          mediaType: { type: 'string' }
        }
      }
    }
  }
}
const publish = {
  summary: 'Begin a private staged publication',
  requestBody: jsonBody(declaration),
  responses: { '201': ok, ...errors }
}

export const openApi = {
  openapi: '3.0.3',
  info: {
    title: 'Forecast Dataset Provider',
    version: '0.2.0',
    description:
      'Experimental contract 0.1. Original-content catalogue; no GRIB/Zarr decoding or subset processor is bundled.'
  },
  servers: [{ url: API_ROOT }],
  paths: {
    '/status': {
      get: {
        summary: 'Catalogue status and implemented operations',
        responses: { '200': ok, ...errors }
      }
    },
    '/datasets': {
      get: {
        summary: 'List latest complete dataset versions (summary map)',
        parameters: [
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
        ].map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
        responses: { '200': ok, ...errors }
      }
    },
    '/datasets/{id}': {
      parameters: [id],
      get: {
        summary: 'Dataset detail, original asset links and inventory state',
        responses: { '200': ok, ...errors }
      },
      delete: {
        summary: 'Delete every version when no reader/publication uses it',
        responses: { '204': ok, ...errors }
      }
    },
    '/datasets/{id}/versions/{version}': {
      parameters: [id, version],
      get: {
        summary: 'Read a particular content version',
        responses: { '200': ok, ...errors }
      }
    },
    '/datasets/{id}/versions/{version}/assets/{asset}': {
      parameters: [id, version, asset],
      get: {
        summary: 'Download immutable original bytes (also supports HEAD)',
        parameters: [
          { name: 'Range', in: 'header', schema: { type: 'string' } },
          { name: 'If-Range', in: 'header', schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Original content',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          '206': { description: 'One byte range' },
          '304': { description: 'Cached content is current' },
          '416': { description: 'Unsatisfiable/unsupported range' },
          ...errors
        }
      }
    },
    '/datasets/{id}/versions/{version}/index': {
      parameters: [id, version],
      get: {
        summary: 'Verified inventory bound to original assets and hashes',
        responses: { '200': ok, ...errors }
      }
    },
    '/datasets/{id}/versions/{version}/inventory': {
      parameters: [id, version],
      put: {
        summary:
          'Admin/indexer: enrich metadata without modifying original content',
        parameters: [
          {
            name: 'If-Match',
            in: 'header',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['metadata', 'index'],
          properties: { metadata, index: { type: 'object' } }
        }),
        responses: {
          '200': ok,
          '412': { description: 'Revision mismatch' },
          '428': { description: 'If-Match required' },
          ...errors
        }
      }
    },
    '/publications': {
      post: publish,
      get: {
        summary:
          'Writer-only: list unfinished publications and live byte/file progress',
        description:
          'Returns a map keyed by publication ID. State is pending, receiving or ready (awaiting explicit commit). Total bytes are null while any asset size remains unknown. No-store; polling supported. Uncommitted bytes are never exposed as usable datasets.',
        responses: { '200': ok, ...errors }
      }
    },
    '/datasets/{id}/publications': { parameters: [id], post: publish },
    '/publications/{publication}': {
      parameters: [publication],
      get: {
        summary:
          'Writer-only staging status with live byte/file progress; resume missing uploads',
        responses: { '200': ok, ...errors }
      },
      delete: {
        summary: 'Abort staging without deleting published source datasets',
        responses: { '204': ok, ...errors }
      }
    },
    '/publications/{publication}/assets/{asset}': {
      parameters: [publication, asset],
      put: {
        summary: 'Upload exactly one declared asset',
        requestBody: {
          required: true,
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' }
            }
          }
        },
        responses: {
          '201': ok,
          '413': {
            description:
              'Declared size or configured asset/dataset limit exceeded'
          },
          '415': { description: 'Unencoded octet-stream required' },
          ...errors
        }
      }
    },
    '/publications/{publication}/commit': {
      parameters: [publication],
      post: {
        summary: 'Atomically publish after every asset is durable',
        responses: { '201': ok, ...errors }
      }
    }
  }
}
