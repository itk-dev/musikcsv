# Service check

Leantime issue 8293, September 2026. Review of musikcsv following reported
instability in Musikhuset's budget forecast.

## Summary

The premise the issue rests on — that the docker compose setup stalls despite
`restart: unless-stopped` — cannot be confirmed from the available data. The
retained telemetry from 7 to 17 September contains no failure: no 5xx, no
memory pressure, no restart triggered by the restart policy.

One confirmed defect was found instead. It can take the budget route out of
service permanently until the next restart, and by design it leaves no trace.
Removing it takes fifteen minutes.

The recommendation is to keep the solution, remove the defect, and make the
system observable before buying anything further. A rebuild cannot be
justified economically.

## Evidence base

| Source | Coverage |
| --- | --- |
| `app.js`, `config.js.dist`, `docker-compose*.yml`, `.docker/vhost.conf` | Full |
| `config.js` from srvwebitk01 | Read 21 Sep |
| `docker compose logs` | 7–17 Sep |
| `docker inspect`, `docker stats`, `free -m` | Snapshot 21 Sep |
| Source of `mssql@9.0.1` | Full |

Reproductions were run in isolated compose stacks locally, not on the server.

## Findings

Each finding is labelled with how certain it is, and whether it has been
observed in production.

### F1 — nginx caches the upstream IP permanently

**Reproduced in lab. Not observed in production.**

`.docker/vhost.conf` uses `proxy_pass http://node:3000;` with a literal
hostname. nginx resolves the upstream IP only at startup and caches it for the
lifetime of the process. If the node container returns on a different IP,
nginx serves 502 permanently. The restart policy on node does not help,
because nginx itself is healthy; only restarting nginx clears it.

Measured locally:

| Scenario | node returns on | Through nginx |
| --- | --- | --- |
| Crash, restart policy starts it again | same IP | 200 |
| Recreated, IP taken by another container | new IP | 502, permanent |
| After restarting nginx | new IP | 200 |

The precondition holds on srvwebitk01: nginx logs Traefik's IP as
`$remote_addr`, and it changed from `172.16.16.6` to `172.16.16.2` across the
restart on 14 September. Container IPs are genuinely reassigned on that host.

There is, however, no 502 or 504 anywhere in the retained access log, so the
fault did not fire in the period we can see.

### F2 — the global connection pool ignores its configuration

**Confirmed against the installed version. Trigger removed 21 Sep; the
underlying defect remains.**

`app.js` calls `sql.connect(config.connections[...])` per request. In mssql
9.0.1 the global pool is created on the first call only; later calls return
the same pool and discard the config object they are handed
(`lib/global-connection.js`). Verified with the real library version and a
stubbed driver:

```text
dagplejelager -> srvsql59  | asked for srvsql59  | actually ran on srvsql59
posidryeartsl -> srvsql41  | asked for srvsql41  | actually ran on srvsql59
```

`config.js` on the server defines two connections. If `/dagplejelager` is
called first after a restart, the budget routes then run against the
`Leverance` database on srvsql59, where `yesplan.Opusdata_ver2` does not
exist. That yields HTTP 500 on `/posidryeartsl.csv` until the container is
restarted.

The `dagplejelager` route contained `Select @@servername` — an unfinished
connectivity test. It was not called once in ten days of logs, but the index
page at `/` exposed it as clickable json and csv links, so one click was
enough.

On 21 September the `dagplejelager` route and the `srvsql59` connection were
removed from `config.js` on the server. With a single connection left the
defect is unreachable, and a set of service account credentials left the file
with it. The defect itself is still in `app.js` and returns the moment a
second connection is added, so `config.js.dist` now carries a warning to that
effect. The proper fix stays in phase 2.

### F3 — no fallback on error, only on an empty result

**Confirmed by reading the code.**

`app.js` falls back to `results/<route>.json` if the query returns zero rows.
On any actual failure — database down, network, timeout, login — it calls
`next(err)` and responds 500. A brief outage on the SQL server therefore
becomes an error in Excel, even though yesterday's figures are on disk.

### F4 — the silent fallback can serve stale figures with status 200

**Confirmed by reading the code. Invisible in logs by design.**

When the fallback is triggered by an empty result, it happens with no log
entry and status 200. If the source table is briefly emptied, for instance by
an integration job that deletes and reloads, musikcsv serves last month's
figures and everything looks correct in the access log.

This is the only failure mode found that fits "instability" without leaving a
trace in the data we have reviewed. It should be investigated first.

### F5 — the application logs essentially nothing

**Confirmed.**

Over ten days the application produced one line: `musikcsv listening on port
3000!`. No requests, no errors, no exit causes. This is why the issue has
stayed open since 2023: there has never been anything to debug.

### F6 — node:18 is end of life, and the dependency tree blocks the upgrade

**Confirmed, and the blocker verified.** No security updates since April 2025.
The target is node 24.

The runtime cannot be bumped on its own. `mssql@9.0.1` pulls in
`@azure/identity@^2.0.4`, which pulls in `@azure/msal-node@^1.10.0`, whose
`engines` field stops at Node 18. Yarn treats that as a hard error:

```text
error @azure/msal-node@1.14.5: The engine "node" is incompatible with this
module. Expected version "10 || 12 || 14 || 16 || 18". Got "24.21.0"
```

It is Azure AD authentication code this app never executes — production uses
NTLM — but the install fails all the same. Note that npm would have installed
it silently, because npm ignores `engines` by default. Yarn failing loudly is
the useful behaviour here.

The way out is verified: `mssql@^11` installs cleanly under yarn on
`node:24-slim`, and `mssql`, `express` and `csv-stringify` all load. Latest is
12.7.2 with `engines: >=18.19.0`.

The thing that could have made this impossible does not: NTLM survives the
upgrade, so production authentication is unaffected.

```js
// mssql@11, lib/tedious/connection-pool.js:19
type: this.config.domain !== undefined ? 'ntlm' : ...
```

`mssql` 9 to 11 is two major versions and drags `tedious` 15 to 18, which
changes connection defaults around encryption. Those need checking against the
production config's `trustServerCertificate: true`.

### F7 — ports are published on all interfaces

**Confirmed by test. Low severity.**

`ports: - "3000"` and `- "8080"` are not `expose`. They publish to a random
high port on `0.0.0.0`:

```text
muhuport-node-1  0.0.0.0:63864->3000/tcp, [::]:63864->3000/tcp
```

The app is therefore reachable bypassing Traefik, and thus bypassing basic
auth. The host sits on the internal network with no DMZ, so the exposure is
towards the municipality's own network. Worth fixing, but not a hole to the
internet.

### F8 — three SQL calls per Excel refresh

**Confirmed. No measured consequence.**

Excel sends OPTIONS, HEAD, GET and HEAD per refresh. Express routes HEAD to
the GET handler, so the query runs three times and `results/<route>.json` is
written three times. The measurements show no load worth mentioning: 111 MiB
memory, 0.02 % CPU, 123 MB written over seven days on a host with 10 GB free.
Noted as waste, not as a problem.

### F9 — the node container runs as root

**Confirmed.** `docker run --rm node:18 id` gives `uid=0(root)`.
Defense in depth, not an active problem.

### F10 — the deploy scripts are not in version control

**Corrected 22 Sep.** An earlier draft of this finding said deployment was
"git pull, remember `yarn install`, restart". That was wrong. Deployment is
scripted and tag-based, in `~/www/musikcsv/scripts/` on the server:

```text
scripts/deploy <git-tag>   fetch, checkout the tag, reset --hard, pull,
                           compose pull, run --rm node yarn install,
                           up --detach, restart, then scripts/test
scripts/docker-compose     wrapper: docker-compose --env-file .env.docker.local
                           --file docker-compose.server.yml
scripts/test               curls / through nginx and pretty-prints it
```

So `yarn install` is not a step anyone can forget, and releases are git tags.
What remains true is narrower, and still worth fixing:

- **The scripts live outside the repository.** They cannot be reviewed, cannot
  be rolled back with the code, and are invisible to anyone reading the
  project. A change to the image or the install command has to be made in two
  places that are not versioned together.
- **`node_modules` is still built in the bind mount**, so the deployed tree is
  not reproducible from a tag alone.
- **The wrapper pins `/usr/local/bin/docker-compose`**, the standalone v1
  binary, which Docker stopped supporting in 2023.
- **`scripts/test` only fetches `/`**, which runs no query. It would report a
  healthy deploy while every data route returned 500.

This also explains the project-name confusion earlier in this review: the
wrapper passes `--env-file .env.docker.local`, while the repository's committed
`.env` sets `COMPOSE_PROJECT_NAME=musikcsv`. Bare `docker compose` in that
directory therefore resolves a different project and reports no containers, on
a stack that is running perfectly.

### F11 — `writeFileSync` is not atomic

**Confirmed by reading the code.** Concurrent requests can read a
half-written cache file. Relevant the moment the cache is made load-bearing,
cf. F3.

### F12 — the vhost discards the client IP and the protocol

**Confirmed by reading the code. A deviation from the ITK standard, not a
fault in it.**

`.docker/vhost.conf` sets two headers:

```nginx
proxy_set_header   X-Forwarded-For $remote_addr;
proxy_set_header   Host $http_host;
```

`X-Forwarded-For` is *overwritten* rather than appended. The idiomatic form is
`$proxy_add_x_forwarded_for`, which appends to any incoming value. Here
`$remote_addr` is Traefik's IP, so the real client address Traefik just put in
the header is discarded. Nothing downstream can see who called.

`X-Forwarded-Proto` is never set at all. That is why `req.protocol` in
`app.js` evaluates to `http`, and why the index route emits `http://` links
even when the page is served over TLS.

`Host $http_host` is correct, and deliberately so: it preserves the original
Host header including the port, which matters on `:8742`.

For contrast, the shared ITK PHP template
(`devops_itkdev-docker/templates/*/.docker/templates/default.conf.template`)
gets this right, with `set_real_ip_from`, `real_ip_header` and
`$proxy_add_x_forwarded_for`. This is a defect in the hand-written vhost for
this project, not in the standard.

Removing nginx (F1) fixes both headers for free, since Traefik sets them
correctly. It then takes one line in `app.js` —
`app.set('trust proxy', 1)` — for Express to believe them.

### F13 — negative amounts keep a decimal point in the CSV

**Confirmed in a running stack.**

`app.js` rewrites decimal points as commas so Excel reads the figures in Danish
locale:

```js
data = data.replace(/(?<=;|^)([0-9]+)\.([0-9]+)(?=;|$)/gm, '$1,$2')
```

The lookbehind requires the number to begin immediately after a `;` or the start
of the line. On a negative amount that position holds the minus sign, so no
negative number ever matches. Live output from the seeded local stack:

```text
-31522.44   negative, period kept
416731,6    positive, comma applied
-76816.2
275704,27
```

Only negatives with a fractional part are affected — a negative whole number
never had a point to convert. In the production sample that is 3 of 50 rows in
`Opusdata_ver2` and 2 of 50 in `Opusdata`, so on the order of 5%, or roughly two
thousand rows across the full 39,325.

The consequence is inconsistency rather than uniform breakage: in a Danish-locale
Excel those cells arrive as text while the positive amounts beside them arrive as
numbers, which is easy to miss in a total.

The fix is one character, `(-?[0-9]+)`, verified against the current behaviour:

```text
current: ["A;8930,82", "B;-156.23"]
fixed:   ["A;8930,82", "B;-156,23"]
```

Add the matching assertion to `test.js` when applying it.

## Ruled out

- **Memory.** node uses 111 MiB. The host has 11.9 GB, of which 10 GB are
  free. `OOMKilled` is `false`. No OOM.
- **5xx in production.** A `grep` for 5xx across the whole retained nginx log
  returned zero hits from 7 to 17 September.
- **Crashes since 14 September.** `RestartCount` is 0 and `ExitCode` 0. Note
  however that `docker compose restart` resets `RestartCount`, which has been
  verified. The counter therefore says something only about the time since the
  manual restart on 14 September at 17:03:59, when the whole stack was
  restarted in one go. The period before that cannot be assessed from it.
- **Query optimisation.** Considered and rejected. There is no load to
  optimise away, cf. F8.

## Plan

### Step 0 — make the work testable (done 22 Sep)

Every item in the phases below changes code or configuration that, until now,
could only be exercised in production. There was no local database, no sample
data, and no test. That is the deeper reason this ticket has stayed open since
2023: not only was there nothing to read when it broke (F5), there was nowhere
to try a fix.

| Task | Est. |
| --- | --- |
| `db` compose profile with a SQL Server container | — |
| 500 rows of synthetic seed data matching the production schema | — |
| `config.dev.js.dist`, so a checkout runs against it unedited | — |
| Smoke test over the served CSV and JSON | — |
| CI running all of it against the production engine | — |
| Production data dumps excluded from git | — |

Done and green on the current `node:18` stack, so later phases change one thing
at a time against a known-good baseline. Setup is in README.md.

Two things this surfaced. The local database is **not** the production database:
production is SQL Server 2017 on Windows Server 2016, while local development
uses `azure-sql-edge`, because real SQL Server is amd64-only and segfaults under
QEMU on Apple Silicon. CI runs the 2017 image on amd64 runners to cover the
difference. And F13 below was found by looking at the output of the seeded
stack — it had been shipping to Musikhuset unnoticed.

### Phase 1 — make the system observable

The point is to be able to diagnose the next incident rather than guess.

| Task | Finding | Est. |
| --- | --- | --- |
| Log every request, every error and every exit cause | F5 | 0.5 h |
| Log explicitly when the cache fallback is triggered | F4 | incl. |
| ~~Delete the `dagplejelager` route and the `srvsql59` connection from `config.js`~~ done 21 Sep | F2 | — |
| Fall back to cache on error, not only on an empty result | F3 | 1 h |
| Push heartbeat from `app.js` to an Uptime Kuma push monitor — written 21 Sep, not yet deployed | F5 | 0.25 h |
| Convert the decimal separator on negative amounts too | F13 | 0.25 h |

Two hours in total, of which the heartbeat is already written. F13 is the odd
one out here — it is a correctness fix rather than observability — but it is a
quarter of an hour against wrong figures reaching Musikhuset every month, so
deferring it behind the phase 2 upgrades would be perverse.

Uptime Kuma cannot reach this host, so the check is inverted: `app.js` pushes
out to a Kuma push monitor on a timer. If the process dies the pushes stop and
Kuma alerts on the silence, so the check fails safe. The push carries
`process.uptime()`, which makes a restart visible in Kuma's history even when
it recovered too quickly to trip an alert.

Two things this deliberately does not do. It does not query the database, so
it reports nothing about data freshness — **F4 is knowingly out of scope.** And
because it runs inside the process, it cannot see the path in through Traefik
and nginx; it would have reported healthy throughout an F1 incident. Removing
nginx in phase 2 shrinks that blind spot to Traefik alone, which is monitored
separately as shared infrastructure.

The `.catch` on the push is load bearing. An unhandled rejection terminates the
process by default in Node, so an unreachable monitor would kill the app it is
watching, and the restart policy would turn that into a crash loop. Verified on
node:24.

In parallel, find out whether `obs-alloy` on srvwebitk01 already collects
container logs. If it does, the history is in Loki and the actual incident
dates can be looked up instead of waiting for the next occurrence.

### Phase 2 — hardening

| Task | Finding | Est. |
| --- | --- | --- |
| Upgrade to node 24, which means upgrading `mssql` past 9 | F6 | 2 h |
| One `ConnectionPool` per named connection | F2 | 1 h |
| Remove nginx, let Traefik route directly to node:3000, and set `trust proxy` | F1, F12 | 1 h |
| `expose:` instead of `ports:`, and `user: node` | F7, F9 | 0.5 h |
| Atomic writes of cache files | F11 | 0.25 h |

The Node upgrade now comes first in this phase, which is a change from the
original ordering. The pool fix in F2 is written against `mssql@9`'s global
connection semantics; doing the upgrade first means that fix is written once,
against the version that will actually run, rather than written twice. The
upgrade estimate has gone from 1 h to 2 h because it is a dependency upgrade
across two major versions of `mssql` and three of `tedious`, not an image bump.

Removing nginx requires moving `ITKBasicAuth@file` to the node service's
labels. Note that `docker-compose.dev.yml` is a shared ITK template file, so
the change should be coordinated with the team. Forgetting it fails loudly:

```text
service "nginx" has neither an image nor a build context specified
```

Note also that nginx currently provides the only request log in the stack.
Phase 1 must be in place first, or it is lost.

### Phase 3 — maintainability

No Dockerfile. It was considered and rejected: no ITK template uses `build:`,
every project on that server is a prebuilt image plus a source bind mount, and
making musikcsv the exception costs more in surprise than it returns. The house
pattern stays; what changes is that the deploy path moves into the repository.

| Task | Finding | Est. |
| --- | --- | --- |
| `Taskfile.yml` (go-task) with `install`, `dev`, `lint`, `test`, `deploy` | F10 | 1 h |
| Prod image to a slim Node tag, with the install and start commands to match | F6, F10 | 0.5 h |
| Markdown and YAML linting, from the shared ITK templates | — | 0.5 h |
| Deployment and operations documentation | F10 | 1 h |
| Deploy, verify and hand over | | 1 h |

**Total estimate: 10.75 hours** — phase 1 two hours, phase 2 four and three
quarters, phase 3 four.

That sits at the top of the 5-10 hours sold for this review, and slightly over
it. Phase 1 and the items already written account for two of those hours and
carry most of the user-visible benefit; phases 2 and 3 are hardening and
maintainability, and can be scoped separately if Musikhuset would rather stop
at a stable service than a tidy one.

The compose split follows house convention and does not change:
`docker-compose.yml` is local development, `docker-compose.server.yml` is
production. Filenames keep the `.yml` spelling, because the server's
`scripts/docker-compose` names `docker-compose.server.yml` explicitly and
renaming would break deployment from outside the repository.

The tasks wrap what already exists rather than replacing it. `scripts/deploy`
becomes a thin shim calling `task deploy <tag>`, so the procedure is reviewed
and rolled back with the code instead of living unversioned on the server.

The slim image forces nothing, which corrects an earlier draft of this section.
`node:24`, `node:24-slim` and `node:24-alpine` all ship yarn 1.22.22, npm 11
and corepack, so `yarn install` in the deploy path and `yarn start` in
`docker-compose.server.yml` both keep working untouched. Slim is 332 MB against
1546 MB for the full tag. Alpine is smaller again at 226 MB, but it is a
different libc for 106 MB on a host with 10 GB free, so slim is the
recommendation.

Switching to npm is not recommended either. The repository has `yarn.lock` and
no `package-lock.json`, so `npm ci` would need one generated, and that
re-resolves the whole dependency tree — every transitive version changing in
the same step as the base image.

JavaScript linting is already in place and running in CI: `standard`, via
`yarn coding-standards-check`. Markdown and YAML are not, and both come from
`devops_itkdev-docker` rather than being invented here — a `markdownlint`
service (`itkdev/markdownlint`, mounting `./:/md`) with `.markdownlint.jsonc`
and `.markdownlintignore`, and a `prettier` service (`jauderho/prettier`,
mounting `./:/work`), both under a `dev` profile. The workflows are copied from
`github/workflows/markdown.yaml` and `github/workflows/yaml.yaml`. `task lint`
should run all three.

Measured against the house configuration, the current state is:

| | Result |
| --- | --- |
| YAML (`docker-compose.yml`, workflows) | clean |
| `README.md` | clean |
| `SERVICEEFTERSYN.md` | 39 violations |

All 39 are in this document and both classes are mechanical: 32 MD060, table
pipes needing spaces around them, and 7 MD040, fenced code blocks without a
language. Worth fixing in the same change that introduces the linter, so it
lands green.

`scripts/test` should also grow beyond fetching `/`. That route runs no query,
so it cannot distinguish a working deploy from one where every data route
returns 500. Pointing it at `task test` reuses the smoke tests from step 0.

## PR stack

Base of the stack is `feature/8293-test-baseline` (PR #16). Every branch below
is cut from its parent, not from `main`. Chains A, B and C are independent of
each other and run in parallel; chain D starts when chain A is done, because it
depends on the Node upgrade and the settled compose shape.

Each agent works in its own git worktree under `.worktrees/` with its own
`COMPOSE_PROJECT_NAME`, runs every command in containers, and must leave
`node test.js` and `yarn coding-standards-check` green. Agents commit in small
scoped commits and stop before pushing. Nothing reaches GitHub without an
explicit ask.

### Chain A — application

| # | Branch | Headline | Findings | Status |
| --- | --- | --- | --- | --- |
| A1 | `feature/8293-logging` | feat: log requests, errors and exits | F5, F4 | not started |
| A2 | `feature/8293-cache-fallback` | fix: fall back to cached results on error | F3, F11 | not started |
| A3 | `feature/8293-negative-decimals` | fix: convert decimal separator on negative amounts | F13 | not started |
| A4 | `feature/8293-heartbeat` | feat: push heartbeat to uptime monitor | F5 | not started |
| A5 | `feature/8293-node-24` | build: upgrade to node 24 and mssql 11 | F6 | not started |
| A6 | `feature/8293-connection-pools` | fix: use one connection pool per named connection | F2 | not started |
| A7 | `feature/8293-drop-nginx` | refactor: serve through traefik without nginx | F1, F12 | not started |

### Chain B — compose

| # | Branch | Headline | Findings | Status |
| --- | --- | --- | --- | --- |
| B1 | `feature/8293-expose-ports` | fix: stop publishing container ports | F7 | not started |
| B2 | `feature/8293-non-root` | chore: run node as non-root | F9 | not started |

### Chain C — documentation and linting

| # | Branch | Headline | Findings | Status |
| --- | --- | --- | --- | --- |
| C1 | `feature/8293-service-review` | docs: add service review | — | not started |
| C2 | `feature/8293-lint` | chore: add markdown and yaml linting | — | not started |

### Chain D — deployment

Starts after A7.

| # | Branch | Headline | Findings | Status |
| --- | --- | --- | --- | --- |
| D1 | `feature/8293-taskfile` | build: add taskfile | F10 | not started |
| D2 | `feature/8293-slim-image` | build: use slim node image in production | F6, F10 | not started |
| D3 | `feature/8293-deploy-docs` | docs: add deployment guide | F10 | not started |

### Status legend

`not started` → `in progress` → `ready to open PR` → `open`.

Fourteen branches, longest path ten steps. Parallelism is bounded by the stack,
not by the machine.

## Alternatives

**Rebuild.** Roughly 40-60 hours for the same functionality. The application
is 110 lines solving one well-defined task. Not recommended.

**Terminating the operations agreement.** Musikhuset loses its monthly budget
forecast. Not recommended without a replacement.

**A nightly job instead of live lookups.** A scheduled job fetches the data
and places the CSV somewhere Excel can always read, removing the dependency on
a running service. 6-10 hours. The error fallback in F3 gives much the same
robustness for one hour, so this is only relevant if Musikhuset wants belt and
braces.

## Open questions

1. **What do the users actually see?** The whole investigation has assumed the
   containers stop. They do not. Is it an error in Excel, a refresh that never
   finishes, or wrong figures? The answer points at very different findings.
2. Does `obs-alloy` collect container logs from this host, and how far back?
   (Container logs are not shipped — confirmed 21 Sep. Metrics may still be.)
3. Are there dates for specific incidents that can be held against the log?
4. Is the source table `yesplan.Opusdata_ver2` ever briefly emptied by an
   integration job? Cf. F4.
