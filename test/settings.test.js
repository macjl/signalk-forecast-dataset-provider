// SPDX-License-Identifier: Apache-2.0
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseSettings,
  settingsSchema,
  BYTES_PER_MIB
} = require('../dist/settings')
const { DEFAULT_LIMITS } = require('../dist/types')

test('size settings expose 2048/8192 MiB without changing internal default limits', () => {
  const schema = settingsSchema().properties
  assert.equal(schema.maxAssetMiB.default, 2048)
  assert.equal(schema.maxDatasetMiB.default, 8192)
  assert.equal(schema.maxAssetBytes, undefined)
  assert.equal(schema.maxDatasetBytes, undefined)
  assert.deepEqual(parseSettings({}).limits, DEFAULT_LIMITS)
  const { limits } = parseSettings({
    maxAssetMiB: 3,
    maxDatasetMiB: 12,
    maxAssets: 20,
    maxStaging: 4
  })
  assert.equal(limits.maxAssetBytes, 3 * BYTES_PER_MIB)
  assert.equal(limits.maxDatasetBytes, 12 * BYTES_PER_MIB)
  assert.equal(limits.maxAssets, 20)
  assert.equal(limits.maxStaging, 4)
  assert.equal(
    parseSettings({ maxAssetMiB: 0.1 }).limits.maxAssetBytes,
    Math.floor(0.1 * BYTES_PER_MIB)
  )
})

test('invalid MiB values and noninteger counts fail without unsafe byte limits', () => {
  for (const value of [
    0,
    -1,
    NaN,
    Infinity,
    '2048',
    null,
    1e-12,
    Number.MAX_SAFE_INTEGER
  ])
    assert.throws(
      () => parseSettings({ maxAssetMiB: value }),
      /Invalid maxAssetMiB/
    )
  assert.throws(
    () => parseSettings({ maxDatasetMiB: -5 }),
    /Invalid maxDatasetMiB/
  )
  assert.throws(() => parseSettings({ maxAssets: 1.5 }), /Invalid maxAssets/)
  assert.throws(() => parseSettings({ maxStaging: 0 }), /Invalid maxStaging/)
})
