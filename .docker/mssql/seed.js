// Loads seed.sql into the local SQL Server container.
//
// Uses the app's own mssql driver rather than sqlcmd, because the arm64
// azure-sql-edge image ships no command line tools. Batches are split on GO,
// which is a sqlcmd separator and not valid T-SQL.

const fs = require('fs')
const path = require('path')
const sql = require('mssql')

const config = {
  server: process.env.MSSQL_HOST || 'mssql',
  port: Number(process.env.MSSQL_PORT || 1433),
  user: 'sa',
  password: process.env.MSSQL_SA_PASSWORD || 'Passw0rd!Local',
  database: 'master',
  // Local throwaway container holding synthetic data: TLS buys nothing, and
  // leaving it on rejects an IP in MSSQL_HOST (tedious refuses an IP as SNI).
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 30000,
  requestTimeout: 120000,
  // One connection, so USE dataintegration holds for every later batch.
  pool: { max: 1 }
}

const batches = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8')
  .split(/^\s*GO\s*$/m)
  .map(batch => batch.trim())
  .filter(Boolean)

const connect = async (attempts = 30) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await new sql.ConnectionPool(config).connect()
    } catch (err) {
      if (i === attempts) throw err
      process.stdout.write(`waiting for ${config.server}:${config.port} (${i}/${attempts})\r`)
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
}

;(async () => {
  const pool = await connect()
  for (const batch of batches) {
    await pool.request().batch(batch)
  }
  const { recordset } = await pool.request()
    .query('SELECT COUNT(*) AS n FROM dataintegration.yesplan.Opusdata_ver2')
  console.log(`seeded ${batches.length} batches, ${recordset[0].n} rows in Opusdata_ver2`)
  await pool.close()
})().catch(err => {
  console.error('seed failed:', err.message)
  process.exit(1)
})
