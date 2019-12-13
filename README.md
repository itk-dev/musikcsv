# musikcsv

## Installation

```sh
git clone https://github.com/itk-dev/musikcsv
cd musikcsv
```

Copy `config.js.dist` to `config.js` and edit appropriately.

```sh
yarn install
```

## Start the show

Install [pm2](https://pm2.keymetrics.io/).

For development, run

```sh
pm2 start ecosystem.config.js --env=development
```

For deployment, run

```sh
pm2 start ecosystem.config.js
```

After updates, run

```sh
pm2 reload ecosystem.config.js
```

## Test the data

```sh
curl http://127.0.0.1:3000/
```
