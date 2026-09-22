const csvStringify = require('csv-stringify').stringify
const express = require('express')
const fs = require('fs')
const path = require('path')
const sql = require('mssql')

const app = express()

// Traefik is the only thing in front of the app and it sets X-Forwarded-For
// and X-Forwarded-Proto itself. Trust that one hop, so req.ip is the real
// client and req.protocol is https on the index page's links.
app.set('trust proxy', 1)

const config = require('./config')

// One line per request: method, path, status, duration, row count, client ip.
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(`req ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms rows=${res.locals.rows === undefined ? '-' : res.locals.rows} ip=${req.ip}`)
  })
  // 'finish' never fires when the client gives up before the response is sent.
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`req ${req.method} ${req.originalUrl} aborted after ${Date.now() - start}ms ip=${req.ip}`)
    }
  })
  next()
})

const getFormat = (path, defaultValue) => {
  const match = /\.([a-z]+)$/g.exec(path)
  return match ? match[1] : defaultValue
}

const getResultFilename = route => path.join(__dirname, 'results', route + '.json')

// Write via a temp file in the same directory and rename, so a kill during the
// write cannot leave a truncated cache on disk. A failed write is logged and
// swallowed: the caller still has a fresh result to serve.
const writeResult = (route, data) => {
  const resultFilename = getResultFilename(route)
  const tempFilename = `${resultFilename}.${process.pid}.tmp`

  try {
    fs.writeFileSync(tempFilename, JSON.stringify(data))
    fs.renameSync(tempFilename, resultFilename)
  } catch (err) {
    console.error(`err cache-write route=${route} ${err.message}`)
    fs.rmSync(tempFilename, { force: true })
  }
}

// Serve the last good result from disk. Returns null when there is none.
const readCachedResult = (route, reason) => {
  const resultFilename = getResultFilename(route)

  try {
    const createdAt = fs.statSync(resultFilename).mtime
    const data = JSON.parse(fs.readFileSync(resultFilename))
    const ageSeconds = Math.round((Date.now() - createdAt.getTime()) / 1000)
    console.error(`warn fallback route=${route} reason=${reason} age=${ageSeconds}s file=${resultFilename}`)
    return { data, createdAt, source: 'cache' }
  } catch (err) {
    console.error(`err no-cache route=${route} reason=${reason} ${err.message}`)
    return null
  }
}

// sql.connect() keeps a single pool for the whole process: the first call
// creates it and every later call gets that same pool back and throws away the
// config it was handed (mssql 11.0.2, lib/global-connection.js - unchanged
// since 9). With more than one connection configured, whichever route was hit
// first decided the database for all of them. One pool per named connection
// instead, created on first use.
const pools = new Map()

const getPool = name => {
  let pool = pools.get(name)

  if (!pool) {
    const p = new sql.ConnectionPool(config.connections[name])
    // mssql re-emits some connection errors on the pool, and an 'error' event
    // with no listener throws.
    p.on('error', err => console.error(`err pool=${name} ${err.message}`))
    pool = p.connect()
    // Drop a pool that never connected, so the next request tries again
    // instead of awaiting the same rejected promise forever.
    pool.catch(() => pools.delete(name))
    pools.set(name, pool)
  }

  return pool
}

for (const [route, spec] of Object.entries(config.routes)) {
  const connectionName = spec.connection || 'default'

  app.get(new RegExp(route + '(?:\\.(csv|json))?$'), async (req, res, next) => {
    let result = null

    try {
      const pool = await getPool(connectionName)
      const { recordset } = await pool.request().query(spec.query)

      if (recordset && recordset.length > 0) {
        writeResult(route, recordset)
        result = { data: recordset, createdAt: new Date(), source: 'query' }
      } else {
        result = readCachedResult(route, 'empty-result')
        if (result === null) return next(new Error('Cannot get data'))
      }
    } catch (err) {
      console.error(`err ${req.method} ${req.originalUrl} ${err.message}`)
      console.error(err.stack)
      result = readCachedResult(route, 'error')
      if (result === null) return next(err)
    }

    res.locals.rows = result.data.length

    // Always stated, so a stale answer is visible to the caller.
    res.header('content-created-at', result.createdAt.toISOString())
    // Excel users never see this, but the smoke test and logs can.
    res.header('x-musikcsv-source', result.source)

    if (getFormat(req.path, 'json') === 'csv') {
      csvStringify(
        result.data,
        {
          header: true,
          delimiter: ';'
        },
        function (err, data) {
          if (err) {
            return next(err)
          }
          res.contentType('text/csv')

          // Hack for Excel!
          // Use , as decimal separator in floating point numbers.
          data = data.replace(/(?<=;|^)(-?[0-9]+)\.([0-9]+)(?=;|$)/gm, '$1,$2')

          res.send(data)
        }
      )
    } else {
      res.send(result.data)
    }
  })
}

app.get('/', (req, res) => {
  const baseUrl = req.protocol + '://' + req.get('host') + req.originalUrl
  const index = {}

  for (const route of Object.keys(config.routes)) {
    const resultUpdatedAt = (() => {
      const resultFilename = getResultFilename(route)

      try {
        return fs.statSync(resultFilename).mtime
      } catch (err) {
        return null
      }
    })()

    index[route] = {
      updatedAt: resultUpdatedAt ? resultUpdatedAt.toISOString() : null,
      json: baseUrl + route + '.json',
      csv: baseUrl + route + '.csv'
    }
  }
  res.send(index)
})

const port = config.port || 3000
const appName = config.appName || 'musikcsv'
app.listen(port, () => console.log(`${appName} listening on port ${port}!`))

// Uptime Kuma cannot reach this host, so the check is inverted: push out on a
// timer and let Kuma alert on the silence. The push carries process.uptime(),
// which makes a restart visible even when it recovered too fast to alert.
// The .catch is load bearing - an unhandled rejection exits the process below,
// so an unreachable monitor would otherwise kill the app it watches. unref()
// keeps the timer from holding the process open past the server.
// Only the first failure and each change between failing and working is
// logged, so a wrong URL or an untrusted CA is visible without a line a minute.
if (config.heartbeatUrl) {
  // Kuma shows the push URL with its query string, and that is what gets pasted.
  const url = new URL(config.heartbeatUrl)
  url.searchParams.set('status', 'up')
  let failing = false

  setInterval(() => {
    url.searchParams.set('msg', `uptime ${Math.round(process.uptime())}s`)
    fetch(url, { signal: AbortSignal.timeout(10000) })
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        if (failing) console.log('heartbeat ok')
        failing = false
      })
      .catch(err => {
        if (!failing) console.error(`err heartbeat ${err.message}${err.cause ? ' ' + err.cause.message : ''}`)
        failing = true
      })
  }, config.heartbeatIntervalMs || 60000).unref()
}

// Log why the process went away. Without this, a crash or a container stop is
// indistinguishable from the app simply vanishing.
const logExit = (cause, code, err) => {
  console.error(`exit cause=${cause}${err === undefined ? '' : ' ' + (err && err.stack ? err.stack : err)}`)
  process.exit(code)
}

process.on('uncaughtException', err => logExit('uncaughtException', 1, err))
process.on('unhandledRejection', err => logExit('unhandledRejection', 1, err))
process.on('SIGTERM', () => logExit('SIGTERM', 0))
process.on('SIGINT', () => logExit('SIGINT', 0))
