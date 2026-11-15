# Man Night Dinner Club (Est. 2007)

Weekly Wichita dinner club PWA at **https://dinner.tylermiranda.com** powered by Cloudflare Workers, Static Assets, D1, Cron Triggers, Web Push, and Google Calendar sync.

## Architecture
- **Frontend (`public/`)**: Vanilla ES2023 PWA ("Tonight" light & dark theme), 4 tabs (`This week`, `History`, `Places`, `Crew`), **Meal Pictures** upload + lightbox photo galleries (with client-side JPEG resizing), 4-step First-Run Walkthrough (with iOS Safari Add-to-Home-Screen guidance), automatic **What’s New** changelog modal with crew idea/bug-report credits (`src/changelog.ts`), MapLibre GL maps, and in-app **Report Issue** modal.
- **API & Cron (`src/`)**:
  - Auth via Cloudflare Access (`Cf-Access-Authenticated-User-Email`) + Service Token fallback (`Cf-Access-Client-Id`).
  - Weekly state machine (`America/Chicago` 15-min Cron):
    - **Sun 10:00 AM**: Night vote opens (Tuesday vs. Wednesday; Tuesday first).
    - **Mon 12:00 PM**: Night locks (Tuesday wins ties).
    - **Dinner Day 12:00 PM (Noon Rule)**: If unpicked, draws 4 random places from club history (skipping anything visited in the last 8 weeks).
    - **Dinner Day 4:00 PM**: Noon vote closes (random tiebreak), locks venue, updates Google Calendar (`Man Night @ <host>'s. Dinner @ <place>`), and pushes crew.
    - **30 min before dinner**: Push reminder carrying a Google Maps directions link (`data.url`).
- **Database (`migrations/`)**: Seeded from `data/seed/man_night.ics` + `places.json` + enriched Wichita coordinates (`614` deduplicated dinners through Nov 10, 2026; `225` distinct places; upcoming rotation starting Nov 17 Eric → Nov 24 Tyler → Dec 1 Heath).

## Development & Tests
```bash
npm ci
npm run typecheck
npm test
npm run dev
```

## Google Calendar Write-Back Setup
After authenticating `gcloud auth login`, run:
```bash
./scripts/setup-gcal-sa.sh
```
Then share the `Man Night` calendar (`cqubssbfpc3ofjf3anej422tec@group.calendar.google.com`) with the created Service Account email (`Make changes to events`).

## CI/CD & Autonomous Issue Fixing
- Pushes to `main` run `.github/workflows/deploy.yml` (`typecheck`, `test`, `wrangler d1 migrations apply --remote`, `wrangler deploy`).
- Submitting the **Report issue** modal in the app creates a labeled (`user-reported`, `auto-fix`) GitHub issue monitored by OpenBot **Man Night Desk** (`man-night-desk`).
