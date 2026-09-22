# musikcsv

## Installation

Install node dependencies:

```sh
docker compose up --detach
docker compose run --rm node yarn install
```

Copy `config.js.dist` to `config.js` and edit appropriately (it's
[JSON5](https://json5.org/)!).

Restart the node container after editing `config.js` to pick up the new configuration:

```sh
docker compose restart node
```

## Local development

The `db` profile adds a SQL Server container seeded with synthetic data, so the
app can be run and changed without access to the production database:

```sh
cp config.dev.js.dist config.js
docker compose run --rm node yarn install
docker compose --profile db up --detach
docker compose run --rm node node .docker/mssql/seed.js
```

The seed script waits for the database to accept connections, so it can be run
immediately after `up`.

Data comes from `.docker/mssql/seed.sql`: 500 synthetic rows matching the
production schema, including negative amounts, `NULL` in `SGTXT` and Danish
characters. It is invented. Dumps of real data must never be committed — see
`.gitignore`.

## The local database is not the production database

Production runs **Microsoft SQL Server 2017** on Windows Server 2016, with NTLM
authentication — the `domain` key in `config.js` is what switches the driver
from SQL Server authentication to NTLM.

Two dates worth knowing: SQL Server 2017 leaves extended support in October
2027, and Windows Server 2016 in January 2027. Neither is musikcsv's to fix —
it is a shared municipal database server — but the app depends on it.

Locally the `db` profile runs `mcr.microsoft.com/azure-sql-edge` instead. That
is a **different product**, not a different version. It was chosen because it is
the only arm64-native option: real SQL Server is published for amd64 only and
segfaults under QEMU on Apple Silicon (exit 139), so it cannot be emulated.

Azure SQL Edge implements a subset of the SQL Server engine, built from a
*newer* codebase than 2017. The compatibility risk therefore runs one way:
something can work locally and fail in production, not the reverse. The queries
this app runs — `SELECT` with `SUBSTRING` and `RIGHT` — behave identically on
both, and that is the whole of the compatibility this setup depends on.
Anything more involved should be checked in CI rather than trusted locally.
Microsoft has also retired Azure SQL Edge.

CI closes that gap by running the same profile against the production engine,
which is native on amd64 GitHub runners:

```sh
MSSQL_IMAGE=mcr.microsoft.com/mssql/server:2017-latest docker compose --profile db up --detach
```

To re-check the production version after a server upgrade:

```sh
idc exec node node -e '
const sql = require("mssql"), c = require("./config");
sql.connect(c.connections["<connection>"])
  .then(p => p.request().query("SELECT @@VERSION AS v"))
  .then(r => console.log(r.recordset[0].v))
  .catch(e => console.error("FAILED:", e.message))
  .finally(() => process.exit(0));
'
```

Replace `<connection>` with the connection name from `config.js`.

If that major version changes, update the pin in
`.github/workflows/test.yml` to match.

## Test the data

```sh
open "http://$(docker compose port nginx 8080)"
```

## Coding standards

```sh
docker compose run --rm node yarn coding-standards-check
docker compose run --rm node yarn coding-standards-apply
```
