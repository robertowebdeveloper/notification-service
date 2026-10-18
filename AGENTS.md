# Repository Guidelines

## Project Structure & Module Organization

`notification-service` is a TypeScript (ESM, strict) service: Fastify API, BullMQ worker and dispatcher, MikroORM on PostgreSQL, Valkey. Design: `docs/notification-service-design.md`; layout and commands: `README.md`.

- `.gitignore` excludes `.promptops/` and `.promptops-assets/`.
- `.promptops/project-context.json` contains generated local project metadata; keep it outside version control.
- When introducing application code, establish clear source and test directories, such as `src/` and `tests/`, and document entry points in a `README.md`.

## Build, Test, and Development Commands

Commands are documented in `README.md` (`npm run build`, `typecheck`, `lint`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, `dev:*`). There is no plain `npm test`.

When selecting a runtime, add its dependency manifest and document exact installation, local startup, build, and test commands in the same contribution. Prefer reproducible commands that also work in CI.

## Coding Style & Naming Conventions

No language, formatter, or linter has been established. With the first implementation, choose the language's standard formatting tools and commit their configuration. Follow that configuration consistently rather than introducing competing styles.

Use descriptive names that reflect notification responsibilities. Keep configuration, transport integrations, and application logic in separate modules as those components emerge. Avoid unrelated formatting changes.

## Testing Guidelines

No testing framework or coverage threshold exists. Add an appropriate framework alongside the first executable feature and document how to run it. Give tests descriptive behavior-based names and follow the selected framework's file naming conventions.

For notification delivery features, cover successful delivery, provider failures, and retry behavior where implemented. Isolate external providers so routine tests do not send real notifications.

## Commit & Pull Request Guidelines

This workspace has no Git repository or available commit history, so no historical message convention can be inferred. Use short, imperative commit subjects, such as `Add notification delivery interface`.

Pull requests should describe the change, its purpose, verification performed, and any configuration requirements. Link relevant issues when available; explain any checks that could not run.

## Security & Configuration

Keep credentials, provider tokens, and real recipient data out of tracked files and test fixtures. When environment configuration is introduced, provide an example containing placeholders and ignore local secret files.
