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
const exportRequest = {
  name: 'request',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' }
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
    expiresAt: { type: 'string', format: 'date-time' },
    expiresInSeconds: { type: 'integer', minimum: 1, maximum: 31536000 },
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
const exportJob = {
  type: 'object',
  required: ['id', 'state', 'href'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    state: {
      type: 'string',
      enum: ['running', 'complete', 'failed', 'expired']
    },
    href: { type: 'string' },
    error: { type: 'string' },
    result: {
      type: 'object',
      required: ['id', 'version', 'href', 'assets'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        version: { type: 'string' },
        href: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        assets: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'href', 'size', 'sha256'],
            properties: {
              id: { type: 'string' },
              href: { type: 'string' },
              size: { type: 'integer' },
              sha256: { type: 'string' }
            }
          }
        }
      }
    }
  }
}
const exportResponse = (description: string) => ({
  description,
  headers: {
    'Retry-After': {
      description: 'Seconds to wait while running',
      schema: { type: 'integer' }
    }
  },
  content: { 'application/json': { schema: exportJob } }
})
const publish = {
  summary: 'Begin a private staged publication',
  requestBody: jsonBody(declaration),
  responses: { '201': ok, ...errors }
}

export const openApi = {
  openapi: '3.0.3',
  info: {
    title: 'Forecast Dataset Provider',
    version: '0.3.0-beta.1',
    description:
      'Experimental contract 0.1. Original-content catalogue with optional delegated GRIB2 export.'
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
    '/datasets/{id}/versions/{version}/requests': {
      parameters: [id, version],
      post: {
        summary: 'Export one GRIB2 file and publish it in the catalogue',
        description:
          'Authentication with write access is required. An empty request exports all assets. Follow the job href if the response is 202.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  operation: {
                    type: 'string',
                    enum: ['export'],
                    default: 'export'
                  },
                  output: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['format', 'layout'],
                    properties: {
                      format: { type: 'string', enum: ['grib2'] },
                      layout: { type: 'string', enum: ['single-file'] }
                    }
                  },
                  expiresInSeconds: {
                    type: 'integer',
                    nullable: true,
                    minimum: 1,
                    maximum: 31536000,
                    default: 1200,
                    description:
                      'Lifetime after commit in seconds. Null means no expiry.'
                  },
                  selection: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      bbox: metadata.properties.bounds,
                      fields: metadata.properties.fields,
                      from: { type: 'string', format: 'date-time' },
                      to: { type: 'string', format: 'date-time' }
                    }
                  }
                }
              },
              examples: {
                assemble: { value: {} },
                crop: { value: { selection: { bbox: [-6, 44, -1, 48] } } }
              }
            }
          }
        },
        responses: {
          '200': exportResponse('An existing result can be read immediately'),
          '202': exportResponse('Export running; follow href to poll'),
          '401': { description: 'Authentication required' },
          '403': { description: 'Write access required' },
          '413': {
            description: 'Source dataset exceeds the export byte limit'
          },
          '422': {
            description:
              'The dataset cannot satisfy the requested operation or selectors'
          },
          '429': {
            description: 'A worker is busy; retry after the indicated delay'
          },
          ...errors
        }
      }
    },
    '/requests/{request}': {
      parameters: [exportRequest],
      get: {
        summary: 'Read export status and the resulting catalogue dataset',
        description:
          'Use the same Signal K identity that submitted the request. Download the returned asset link through the standard dataset API.',
        responses: {
          '200': exportResponse('Job status; result is present once published'),
          '401': { description: 'Authentication required' },
          '403': {
            description: 'Authentication required for private job status'
          },
          ...errors
        }
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
