// Smoke test against a running stack seeded from .docker/mssql/seed.sql.
//
//   docker compose --profile db up --detach
//   docker compose run --rm node node .docker/mssql/seed.js
//   docker compose run --rm node node test.js
//
// Asserts what the stack does today. Known defects are not asserted here -
// add the assertion when fixing one.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE_URL || 'http://node:3000'
const SEEDED_ROWS = 500

const checks = []
const check = (name, fn) => checks.push([name, fn])

// Checks that need the seeded database or the extra routes in
// config.dev.js.dist. After a deploy the config is the production one, so run
// only the rest:
//
//   SMOKE=1 node test.js
//
// What is left still queries the real database, which is the point: fetching
// only / proves nothing, because / runs no query.
const devCheck = (name, fn) => { if (!process.env.SMOKE) check(name, fn) }

check('index lists both routes', async () => {
  const res = await fetch(`${BASE}/`)
  assert.strictEqual(res.status, 200)
  const body = await res.json()
  assert.ok(body.posidryeartsl, 'posidryeartsl missing from index')
  assert.ok(body.posidryeartsl_old, 'posidryeartsl_old missing from index')
})

// Traefik terminates TLS and forwards X-Forwarded-Proto. Without
// app.set('trust proxy') express ignores it and the index emits http:// links
// on a page served over https.
check('the index honours the forwarded protocol', async () => {
  const body = await (await fetch(`${BASE}/`, { headers: { 'x-forwarded-proto': 'https' } })).json()
  assert.ok(body.posidryeartsl.csv.startsWith('https://'), `forwarded proto ignored: ${body.posidryeartsl.csv}`)
})

check('csv has the expected columns', async () => {
  const res = await fetch(`${BASE}/posidryeartsl.csv`)
  assert.strictEqual(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/csv/)
  assert.ok(res.headers.get('content-created-at'), 'content-created-at header missing')
  assert.strictEqual(res.headers.get('x-musikcsv-source'), 'query', 'served from the cache, not the database')
  const [header] = (await res.text()).split('\n')
  assert.strictEqual(header.trim(), 'POSID;RYEAR;TSL;XD_tal;PSP5;TXTMD;SGTXT')
})

devCheck(`csv returns all ${SEEDED_ROWS} seeded rows`, async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl.csv`)).text()
  const rows = text.trim().split('\n').slice(1)
  assert.strictEqual(rows.length, SEEDED_ROWS)
})

devCheck('json returns the same rows as objects', async () => {
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

check('decimal amounts use a comma for excel, negatives included', async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl.csv`)).text()
  const amounts = text.trim().split('\n').slice(1).map(line => line.split(';')[2])
  assert.ok(amounts.some(a => !a.startsWith('-') && a.includes(',')), 'no positive decimal got a comma')
  assert.ok(amounts.some(a => a.startsWith('-') && a.includes(',')), 'no negative decimal got a comma')
  assert.deepStrictEqual(amounts.filter(a => a.includes('.')), [], 'a decimal amount kept its period')
})

check('the old route still serves its own columns', async () => {
  const text = await (await fetch(`${BASE}/posidryeartsl_old.csv`)).text()
  const [header] = text.split('\n')
  assert.strictEqual(header.trim(), 'POSID;RYEAR;TSL;XD_tal;PSP5;XD_streng')
})

// config.dev.js.dist defines always_fails, whose query never succeeds, so the
// route can only answer from results/always_fails.json.
const FALLBACK_CACHE = path.join(__dirname, 'results', 'always_fails.json')
const CACHED_ROWS = [{ POSID: 'cached', TSL: 1 }]
const CACHED_AT = new Date('2020-01-02T03:04:05.000Z')

devCheck('a failing query is served from the cache', async () => {
  fs.writeFileSync(FALLBACK_CACHE, JSON.stringify(CACHED_ROWS))
  fs.utimesSync(FALLBACK_CACHE, CACHED_AT, CACHED_AT)
  // The app runs in another container, so the bind mount can take a moment to
  // show it the file this process just wrote.
  let res = await fetch(`${BASE}/always_fails.json`)
  for (let i = 0; i < 10 && res.status !== 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    res = await fetch(`${BASE}/always_fails.json`)
  }
  assert.strictEqual(res.status, 200)
  assert.deepStrictEqual(await res.json(), CACHED_ROWS)
  assert.strictEqual(
    res.headers.get('content-created-at'),
    CACHED_AT.toISOString(),
    'content-created-at does not report the age of the cache'
  )
  assert.strictEqual(res.headers.get('x-musikcsv-source'), 'cache')
})

devCheck('a failing query without a cache is a 500', async () => {
  fs.rmSync(FALLBACK_CACHE, { force: true })
  // A deleted file takes as long to reach the other container as a new one.
  let res = await fetch(`${BASE}/always_fails.json`)
  for (let i = 0; i < 10 && res.status !== 500; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    res = await fetch(`${BASE}/always_fails.json`)
  }
  assert.strictEqual(res.status, 500)
})

// config.dev.js.dist points wrong_server at a host that does not exist, so the
// route can only answer if it was handed some other connection's pool. The
// seeded stack has a single database, so the second server is an unreachable
// one rather than a second container.
const WRONG_SERVER_CACHE = path.join(__dirname, 'results', 'wrong_server.json')

devCheck('a named connection does not borrow another connection pool', async () => {
  fs.rmSync(WRONG_SERVER_CACHE, { force: true })
  // Open the mssql pool first - that is the pool the old code handed out to
  // every later connection name.
  assert.strictEqual((await fetch(`${BASE}/posidryeartsl.json`)).status, 200)
  const res = await fetch(`${BASE}/wrong_server.json`)
  assert.strictEqual(res.status, 500, 'wrong_server answered, so it queried another connection server')
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
