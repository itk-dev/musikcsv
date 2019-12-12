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

// @TODO: Someone has to read up on error handling!
for (const [route, spec] of Object.entries(config.routes)) {
  console.log(route)
  app.get(new RegExp(route + '(?:\.(csv|json))?$'), async (req, res, next) => {
    try {
      const connection = await sql.connect(config.connections[spec.connection])
      const result = await sql.query(spec.query)
      let data = result.recordset
      let createdAt = new Date()

      await connection.close()

      const lastResultFilename = path.join(__dirname, 'results', route + '.json')

      if (data === null || data.length === 0) {
        try {
          const content = fs.readFileSync(lastResultFilename)
          data = JSON.parse(content)
          createdAt = fs.statSync(lastResultFilename).birthtime
        } catch (exception) {
          throw new Error('Cannot get data')
        }
      } else {
        fs.writeFileSync(lastResultFilename, JSON.stringify(data))
      }

      const format = getFormat(req.path, 'json')

      if (format === 'csv') {
        await csvStringify(
          data,
          {
            header: true
          },
          function (err, data) {
            if (err) {
              throw err
            }
            res.contentType('text/csv')
            res.header('content-created-at', createdAt.toISOString())
            res.send(data)
          }
        )
      } else {
        res.send(data)
      }
    } catch (exception) {
      next(exception)
    }
  })
}

app.get('/', (req, res) => {
  const baseUrl = req.protocol + '://' + req.get('host') + req.originalUrl
  const index = {}

  for (const [route, spec] of Object.entries(config.routes)) {
    index[route] = {
      json: baseUrl + route + '.json',
      csv: baseUrl + route + '.csv'
    }
  }
  res.send(index)
})

const port = config.port || 3000
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
