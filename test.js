// Smoke test against a running stack seeded from .docker/mssql/seed.sql.
//
//   docker compose --profile db up --detach
//   docker compose run --rm node node .docker/mssql/seed.js
//   docker compose run --rm node node test.js
//
// Asserts what the stack does today. Known defects are recorded in
// SERVICEEFTERSYN.md, not asserted here - add the assertion when fixing one.

const assert = require('assert')

const BASE = process.env.BASE_URL || 'http://nginx:8080'
const SEEDED_ROWS = 500

const checks = []
const check = (name, fn) => checks.push([name, fn])

check('index lists both routes', async () => {
  const res = await fetch(`${BASE}/`)
  assert.strictEqual(res.status, 200)
  const body = await res.json()
  assert.ok(body.posidryeartsl, 'posidryeartsl missing from index')
  assert.ok(body.posidryeartsl_old, 'posidryeartsl_old missing from index')
})

check('csv has the expected columns', async () => {
  const res = await fetch(`${BASE}/posidryeartsl.csv`)
  assert.strictEqual(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/csv/)
  assert.ok(res.headers.get('content-created-at'), 'content-created-at header missing')
  const [header] = (await res.text()).split('\n')
  assert.strictEqual(header.trim(), 'POSID;RYEAR;TSL;XD_tal;PSP5;TXTMD;SGTXT')
})

check(`csv returns all ${SEEDED_ROWS} seeded rows`, async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl.csv`)).text()
  const rows = text.trim().split('\n').slice(1)
  assert.strictEqual(rows.length, SEEDED_ROWS)
})

check('json returns the same rows as objects', async () => {
  const body = await (await fetch(`${BASE}/posidryeartsl.json`)).json()
  assert.strictEqual(body.length, SEEDED_ROWS)
  assert.deepStrictEqual(
    Object.keys(body[0]).sort(),
    ['POSID', 'PSP5', 'RYEAR', 'SGTXT', 'TSL', 'TXTMD', 'XD_tal'].sort()
  )
})

check('danish characters survive the csv encoding', async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl.csv`)).text()
  assert.match(text, /[æøåÆØÅ]/, 'no danish characters in output - encoding lost')
})

check('positive decimals use a comma for excel', async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl.csv`)).text()
  const amounts = text.trim().split('\n').slice(1).map(line => line.split(';')[2])
  const positives = amounts.filter(a => !a.startsWith('-') && a.includes(','))
  assert.ok(positives.length > 0, 'no positive decimal was converted to a comma')
  assert.ok(
    amounts.every(a => !(!a.startsWith('-') && a.includes('.'))),
    'a positive decimal kept its period'
  )
})

check('the old route still serves its own columns', async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl_old.csv`)).text()
  const [header] = text.split('\n')
  assert.strictEqual(header.trim(), 'POSID;RYEAR;TSL;XD_tal;PSP5;XD_streng')
})

// The dev container runs nodemon, so the app may be mid-restart. Wait for it
// rather than racing it.
const waitForApp = async (attempts = 30) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`${BASE} never became ready`)
}

;(async () => {
  await waitForApp()
  let failed = 0
  for (const [name, fn] of checks) {
    try {
      await fn()
      console.log(`  ok    ${name}`)
    } catch (err) {
      failed++
      console.log(`  FAIL  ${name}\n        ${err.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  process.exit(failed ? 1 : 0)
})()
