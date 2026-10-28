# Contributing to Atlas

Thanks for your interest. Bug reports, documentation fixes and pull requests are welcome. For larger changes, please open an issue first to discuss the approach.

## Development setup

1. Install Node.js 24 or newer (`nvm install && nvm use` reads `.nvmrc`).
2. Clone and install:

   ```sh
   git clone https://github.com/nmucke/atlas.git && cd atlas
   npm ci
   ```

3. Start the development server with live reloading:

   ```sh
   npm run dev
   ```

4. Open [http://127.0.0.1:3210](http://127.0.0.1:3210).

Use `npm ci` rather than `npm install` so dependencies match `package-lock.json`.

To keep development data apart from your real library, set a separate data directory, for example `ATLAS_DATA_DIR=/tmp/atlas-dev npm run dev`.

## Checks before a pull request

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

`npm run format` fixes formatting. Tests use temporary fixture databases and mocked integrations, so Zotero, an AI account and your private library are not needed.

Assistant instructions and workflow skills live in `assistant-workspace/`. They are research instructions for end users' assistants, not developer instructions for this repository.

## Keep private data out of commits

Atlas stores its database outside the repository by default, and `.gitignore` excludes databases, PDFs, `.bib` files, environment files and the assistant token. Still, review `git status` before committing and make sure no private files, exports or PDFs are staged.

## Continuous integration

- **CI** runs on pushes and pull requests with Node.js 24 on Linux, macOS and Windows. It checks formatting (including assistant instructions and skills), runs the test suite, typechecks, and builds the production app.
- **Dependency audit** checks the lockfile for high and critical vulnerabilities whenever dependency files change, every Monday, and on manual runs.
- **Dependabot** proposes weekly updates for npm dependencies and pinned GitHub Actions. Minor and patch npm updates are grouped; major updates stay separate.

Workflows have read-only repository permissions and do not deploy, publish packages or upload data.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
