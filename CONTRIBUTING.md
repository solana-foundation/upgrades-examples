# Contributing

Each upgrade lives in its own top-level directory, named after its page on [solana.com/upgrades](https://solana.com/upgrades), and is self-contained: its own `Justfile`, README, dependencies, and toolchain pins.

## Adding an upgrade

1. Create `<upgrade>/` with a `Justfile` and a `README.md` covering setup, examples, and version requirements.
2. Add `.github/workflows/<upgrade>.yml`, scoped to that directory so it only runs when the upgrade changes:

   ```yaml
   name: <upgrade>

   on:
     push:
       branches: [main]
       paths:
         - <upgrade>/**
         - .github/workflows/<upgrade>.yml
     pull_request:
       paths:
         - <upgrade>/**
         - .github/workflows/<upgrade>.yml

   defaults:
     run:
       working-directory: <upgrade>
   ```

   Step-level `working-directory` and action inputs such as cache or lockfile paths are relative to the repo root, so prefix them with `<upgrade>/`. [`transaction-v1.yml`](.github/workflows/transaction-v1.yml) is a working example.
3. Add a row to the table in the root [`README.md`](README.md) linking the directory and its solana.com/upgrades page.
