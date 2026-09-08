# Alliance Jiu-Jitsu — Attendance & Belt Progression App

Replaces GymDesk for Alliance Jiu-Jitsu Costa Rica (Escazú + Escalante academies).
See `PROJECT_SPEC.md` for the full product spec and `docs/superpowers/plans/` for
phase-by-phase implementation plans.

## Local setup

1. `pnpm install`
2. Copy `.env.example` to `.env` (defaults already match `docker-compose.yml`)
3. `pnpm db:up` — starts local Postgres in Docker
4. `pnpm db:migrate` — applies all migrations
5. `pnpm db:seed` — seeds both academies, belt requirements, Escazú's class
   schedule, payment plans, and one admin user (credentials printed to console
   on first run — change the password after logging in once auth ships)
6. `pnpm dev` — starts the app at http://localhost:3000 (redirects to `/es`)

## Scripts

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint`
- `pnpm test` — unit + integration tests (integration tests need `pnpm db:up`
  and a seeded database)
- `pnpm db:up` / `pnpm db:down` — local Postgres via Docker Compose
- `pnpm db:migrate` — `prisma migrate dev`
- `pnpm db:seed` — `prisma db seed`

## Dev-only pages

- `/es/dev/belts` (or `/en/dev/belts`) — visual QA page showing all 5 belts ×
  0–4 stripes for the belt-graphic component.
