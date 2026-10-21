// SPDX-License-Identifier: Apache-2.0
const test = require('node:test')
const assert = require('node:assert/strict')
const parser = require('@apidevtools/swagger-parser')
const { openApi } = require('../dist/openapi')
test('published OpenAPI document is valid and advertises only implemented endpoints', async () => {
  const document = await parser.validate(structuredClone(openApi))
  assert.equal(document.openapi, '3.0.3')
  assert.equal(
    document.servers[0].url,
    '/plugins/signalk-forecast-dataset-provider'
  )
  assert.ok(document.paths['/publications/{publication}/commit'])
  assert.ok(document.paths['/publications'].get)
  assert.deepEqual(
    document.paths['/publications'].post.requestBody.content['application/json']
      .schema.properties.assets.items.required,
    ['id']
  )
  assert.equal(document.paths['/processors'], undefined)
})
