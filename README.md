# musikcsv

## Tasks

Everything goes through [go-task](https://taskfile.dev), and everything
except `task` itself runs in a container. `task` has to be installed on the
host, the server included:

```sh
task install   # yarn install in the node container
task dev       # start the stack with the db profile and seed it
task lint      # standard, markdownlint and prettier
task test      # smoke test the running stack
```

The tasks run `docker compose`; set `TASK_DOCKER_COMPOSE` to use another
command, e.g. `TASK_DOCKER_COMPOSE=idc task install`.

`task deploy TAG=1.2.3` is the deploy on the server: fetch, check out the tag,
`reset --hard`, pull the images, install, `up --detach --remove-orphans`,
restart, then the smoke test. It runs through `itkdev-docker-compose-server`,
which is installed on ITK's docker servers and reads the compose files from
`COMPOSE_FILES` in `.env.docker.local`, so that file needs:

```sh
COMPOSE_FILES=docker-compose.server.yml
```

It replaces the scripts in `scripts/` on the server, which lived outside
version control and pinned the unsupported `docker-compose` v1 binary.

The last step is the point of the change. The old `scripts/test` fetched `/`,
which runs no query, so it reported a healthy deploy while every data route
returned 500. `SMOKE=1 node test.js` drops the checks that need the seeded
database and keeps the ones that query the real one, and fails if the answer
came from the cache rather than a fresh query.

## Deployment

Releases are git tags.

```sh
ssh <host>
cd <deploy path>
task deploy TAG=1.2.3
```

That fetches the tags, checks out `TAG`, `reset --hard`, pulls the images,
installs, brings the stack up, restarts it and runs the smoke test. Rolling
back is the same command with the previous tag, down to the first tag that
has a `Taskfile.yml`. Older tags have none: `task deploy` would check one out
and then have nothing to run the next deploy with.

Verify afterwards — the smoke test covers both, but by hand:

- `/` lists both routes, `posidryeartsl` and `posidryeartsl_old`.
- `/posidryeartsl.csv` answers 200, and its `content-created-at` header is
  from the deploy, not hours old. A stale timestamp means the route is being
  served from `results/posidryeartsl.json` instead of the database.

### The compose project on the server is the directory name

`.env.docker.local` sets no project name, so compose falls back to the
directory name. The committed `.env` sets `COMPOSE_PROJECT_NAME=musikcsv`, so
bare `docker compose` in that directory resolves the `musikcsv` project and
reports zero containers on a stack that is running. `task deploy` runs through
`itkdev-docker-compose-server`, which uses `.env.docker.local` and the files in
its `COMPOSE_FILES` (see [Tasks](#tasks)). For anything else on the server, use
`idc` ([itkdev-docker](https://github.com/itk-dev/devops_itkdev-docker)):

```sh
idc ps
```

### config.js

`config.js` is not in git. It exists only on the server, and it holds the only
credentials the application has — the service account for the production
database. `git checkout` and `reset --hard` leave it alone because
`.gitignore` covers it.

Backups of it must not live in the checkout.

The database it points at is described under [The local database is not the
production database](#the-local-database-is-not-the-production-database):
SQL Server 2017 on Windows Server 2016, NTLM authentication through the
`domain` key.

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

## Uptime monitor

The app can push a heartbeat to an [Uptime Kuma](https://uptime.kuma.pet/)
push monitor. The monitor cannot reach the server, so the check is inverted:
the app calls out on a timer, and Kuma alerts when the calls stop. It is off
unless `heartbeatUrl` is set in `config.js`:

```js
heartbeatUrl: 'https://uptime.example.com/api/push/abc123',
heartbeatIntervalMs: 60000, // optional, defaults to 60000
```

Paste the push URL as Kuma shows it. The app sets `status` and `msg` itself,
so leaving `?status=up&msg=OK&ping=` on it is fine. Each push reports the process uptime
as the message, which makes a restart visible in Kuma's history even when it
recovered too fast to alert.

A push monitor has no request timeout; its **Heartbeat Interval** is the
timeout. Kuma marks the monitor down when no push has arrived within it. Set it
to at least **3 × `heartbeatIntervalMs`**, with **1 retry**, so 180 seconds for
the default 60 seconds.

The factor comes from the longest normal gap between two pushes. The first
push after a start is sent one full interval later, not at once, so a restart
right before a push is due leaves a gap of about two intervals plus the
restart time. One lost push, a network blip or a slow monitor, gives the same
two intervals. Three covers either with room to spare, and the retry means a
single late push is marked pending rather than paging. At 2 × or less, a
deploy can page.

A failing push never affects the app. The first failure is logged as
`err heartbeat ...` and recovery as `heartbeat ok`; nothing in between, so a
wrong URL or an unreachable monitor shows up once in the node log
(`idc logs node` on the server) rather than every minute.

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

Run through `idc` (the `itkdev-docker-compose` wrapper) rather than bare
`docker compose`, because on that server bare `docker compose` resolves a
different project name and reports no containers.

If that major version changes, update the pin in
`.github/workflows/test.yml` to match.

## Test the data

```sh
open "http://$(docker compose port node 3000)"
```

## Coding standards

```sh
docker compose run --rm node yarn coding-standards-check
docker compose run --rm node yarn coding-standards-apply
```
