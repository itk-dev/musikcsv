const csvStringify = require('csv-stringify')
const express = require('express')
const fs = require('fs')
const path = require('path')
const sql = require('mssql')

const app = express()

const config = require('./config')

const getFormat = (path, defaultValue) => {
  const match = /\.([a-z]+)$/g.exec(path)
  return match ? match[1] : defaultValue
}

const getResultFilename = route => path.join(__dirname, 'results', route + '.json')

// @TODO: Someone has to read up on error handling!
for (const [route, spec] of Object.entries(config.routes)) {
  app.get(new RegExp(route + '(?:\\.(csv|json))?$'), async (req, res, next) => {
    sql.connect(config.connections[spec.connection || 'default'])
      .then(pool => {
        return pool.request().query(spec.query)
      })
      .then(result => {
        let data = result.recordset
        let createdAt = new Date()

        const resultFilename = getResultFilename(route)

        if (data === null || data.length === 0) {
          try {
            const content = fs.readFileSync(resultFilename)
            data = JSON.parse(content)
            createdAt = fs.statSync(resultFilename).mtime
          } catch (exception) {
            throw new Error('Cannot get data')
          }
        } else {
          fs.writeFileSync(resultFilename, JSON.stringify(data))
        }

        const format = getFormat(req.path, 'json')

        res.header('content-created-at', createdAt.toISOString())

        if (format === 'csv') {
          csvStringify(
            data,
            {
              header: true
            },
            function (err, data) {
              if (err) {
                throw err
              }
              res.contentType('text/csv')
              res.send(data)
            }
          )
        } else {
          res.send(data)
        }
      })
      .catch(err => {
        next(err)
      })
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
