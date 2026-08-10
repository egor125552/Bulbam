# Deployment

Bulbam uses one production deployment path: **Cloudflare Workers Builds** connected directly to this GitHub repository.

## Source of truth

- Pull requests and pushes are validated by GitHub Actions (`Verify Bulbam`).
- Cloudflare Workers Builds owns deployment to `bulbam-api`.
- The production branch is `main`.
- Cloudflare's Git integration automatically builds/deploys pushes and reports deployment status back to GitHub.
- The Cloudflare-managed build token is the deployment credential. Do not copy it into GitHub Actions and do not create a second `CLOUDFLARE_API_TOKEN` solely for deployment.

## Why there is no GitHub deploy workflow

Running `wrangler deploy` from GitHub Actions in parallel with Workers Builds creates two independent deployment authorities. That can cause races, duplicate deployments, confusing statuses, and a second long-lived production credential.

GitHub Actions therefore verifies code only. Cloudflare deploys it.

## Production checks

Repository integration tests cover registration, D1 persistence, direct messaging, idempotency, and delivery receipts before merge. After deployment, Cloudflare's own build result is the authoritative deployment signal. User-visible end-to-end behavior should still be checked in the live web client for release-critical messaging changes.
