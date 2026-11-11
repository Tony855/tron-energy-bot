# Runtime and dependency upgrade policy

## Supported runtime matrix

- Node.js 24 LTS and Node.js 26 LTS are CI-tested.
- Fresh installs use the NodeSource 26.x channel.
- The application engine range is Node.js >=24 <27. Node.js 22 and older are no longer supported by this release line.
- MariaDB 11.4 LTS and 11.8 LTS are tested in CI. Production database upgrades remain a separately rehearsed operation; CI compatibility does not authorize an in-place production server upgrade.

## Direct application dependencies

The current lockfile pins these resolved lines:

| Package | Resolved line | Upgrade notes |
|---|---:|---|
| bcryptjs | 3.0.3 | API compatibility test covers synchronous hash and compare |
| dotenv | 18.0.10 | No app-level API changes; continue using config() |
| express | 4.22.3 | Stay on the latest Express 4 line for this batch; Express 5 is a separate compatibility migration |
| grammy | 1.46.0 | Telegram bot API client |
| helmet | 8.3.0 | Security headers |
| jsonwebtoken | 9.0.3 | JWT signing and verification |
| mysql2 | 3.24.6 | MariaDB/MySQL protocol client |
| socket.io | 4.8.4 | Realtime event delivery |

## Installation and reproducibility

- Fresh installation and staged upgrade use `npm ci`, not mutable `npm install`.
- The committed `package-lock.json` is the dependency source of truth.
- CI blocks high and critical npm audit findings.
- Dependabot checks npm packages and GitHub Actions weekly. Patch/minor updates are grouped; major updates are isolated for review.
- Do not auto-merge major updates. Each major update must pass the full Node/MariaDB matrix and explicit application-level compatibility review.

## Deferred compatibility migrations

Express 5 is not bundled into this batch. Its route matching, middleware, and async error-handling changes require a separate source audit and regression suite. A future Express 5 PR must pass all webhook, authentication, admin, Socket.IO, and error-boundary tests before adoption.

Operating-system and production database upgrades must be applied with a tested backup, restore rehearsal, maintenance window, and rollback plan. No CI matrix result substitutes for a production restore test.
