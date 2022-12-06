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

## Test the data

```sh
open "http://$(docker compose port nginx 8080)"
```

## Coding standards

```sh
docker compose run --rm node yarn coding-standards-check
docker compose run --rm node yarn coding-standards-apply
```
