# musikcsv

## Installation

```sh
git clone https://github.com/itk-dev/musikcsv
cd musikcsv
```

Copy `config.js.dist` to `config.js` and edit appropriately.

```sh
docker compose up --detach
docker compose run --rm node yarn install
```

## Test the data

```sh
curl http://127.0.0.1:3000/
```
