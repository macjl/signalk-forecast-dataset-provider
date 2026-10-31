// SPDX-License-Identifier: Apache-2.0
const test = require('node:test')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const path = require('node:path')

// Signal K currently supplies an Express 4 router. Run the HTTP lifecycle tests
// with that host while the plugin continues to use its own Express 5 middleware.
test('HTTP contract works with an Express 4 host and Express 5 middleware', async () => {
  try {
    await promisify(execFile)(
      process.execPath,
      ['--test', path.join(__dirname, 'http.test.js')],
      {
        env: { ...process.env, FORECAST_TEST_EXPRESS: '4' },
        timeout: 30000
      }
    )
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`, {
      cause: error
    })
  }
})
