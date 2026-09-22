const csvStringify = require('csv-stringify').stringify
const express = require('express')
const fs = require('fs')
const path = require('path')
const sql = require('mssql')

const app = express()

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

// Write via a temp file in the same directory and rename, so a concurrent
// reader never sees a half-written cache.
const writeResult = (route, data) => {
  const resultFilename = getResultFilename(route)
  const tempFilename = `${resultFilename}.${process.pid}.tmp`

  fs.writeFileSync(tempFilename, JSON.stringify(data))
  fs.renameSync(tempFilename, resultFilename)
}

// Serve the last good result from disk. Returns null when there is none.
const readCachedResult = (route, reason) => {
  const resultFilename = getResultFilename(route)

  try {
    const createdAt = fs.statSync(resultFilename).mtime
    const data = JSON.parse(fs.readFileSync(resultFilename))
    const ageSeconds = Math.round((Date.now() - createdAt.getTime()) / 1000)
    console.error(`warn fallback route=${route} reason=${reason} age=${ageSeconds}s file=${resultFilename}`)
    return { data, createdAt }
  } catch (err) {
    console.error(`err no-cache route=${route} reason=${reason} ${err.message}`)
    return null
  }
}

for (const [route, spec] of Object.entries(config.routes)) {
  app.get(new RegExp(route + '(?:\\.(csv|json))?$'), async (req, res, next) => {
    let result = null

    try {
      const pool = await sql.connect(config.connections[spec.connection || 'default'])
      const { recordset } = await pool.request().query(spec.query)

      if (recordset && recordset.length > 0) {
        writeResult(route, recordset)
        result = { data: recordset, createdAt: new Date() }
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
          data = data.replace(/(?<=;|^)([0-9]+)\.([0-9]+)(?=;|$)/gm, '$1,$2')

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
