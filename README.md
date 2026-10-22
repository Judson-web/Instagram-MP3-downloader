# ReelTone

A focused web app for converting publicly accessible Instagram Reels and video posts into MP3 audio.

[![Website](https://img.shields.io/website?url=https%3A%2F%2Finstagram-mp3-downloader.vercel.app&label=website)](https://instagram-mp3-downloader.vercel.app/)
[![Service health](https://img.shields.io/endpoint?url=https%3A%2F%2Finstagram-mp3-downloader.vercel.app%2Fapi%2Fhealth%2Fbadge)](https://instagram-mp3-downloader.vercel.app/api/health)
[![CI](https://github.com/Judson-web/Instagram-MP3-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/Judson-web/Instagram-MP3-downloader/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/github/license/Judson-web/Instagram-MP3-downloader)](LICENSE)
[![TypeScript](https://img.shields.io/badge/source-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Vercel](https://img.shields.io/badge/hosted%20on-Vercel-black?logo=vercel&logoColor=white)](https://vercel.com/)

**Live site:** https://instagram-mp3-downloader.vercel.app/

## Features

- Convert publicly accessible Reel and video-post URLs into MP3.
- Choose 128, 192, 256, or 320 kbps.
- Compact, keyboard-accessible bitrate picker with four presets and concise quality labels.
- Light and dark themes with a remembered preference.
- Temporary browser download that expires after ten minutes.
- Clear, specific messages for invalid or unavailable links.
- Responsive desktop and mobile layouts.
- Search metadata, social sharing metadata, a branded 1200 × 630 Open Graph/Twitter preview card (PNG generated from the editable SVG source during build), and structured data.
- Application health endpoint and live status badge.

## Technology

- **Application:** TypeScript, Node.js, Express
- **Audio:** FFmpeg and yt-dlp tooling
- **Database:** Neon Postgres
- **Deployment:** Vercel
- **Checks:** TypeScript compiler, Node.js privacy unit tests, and GitHub Actions

TypeScript is the maintained application source, including the preview-image build step. Browser and Node.js runtime JavaScript plus the PNG preview are generated during the build and excluded from source control.

## Local development

Requirements: Node.js 22 or later and a Neon Postgres database.

1. Clone this repository.
2. Install dependencies with `npm install`.
3. Set `DATABASE_URL` to your Neon connection string.
4. Set `RATE_LIMIT_SECRET` to a cryptographically random value of at least 32 bytes.
5. Run `npm run check` to type-check the application.
6. Run `npm test` to verify IP anonymization behavior.
7. Run `npm run build` to test and compile the TypeScript runtime files.
8. Run `npm start` and open http://localhost:3000.

Keep environment files and secret values out of Git. Configure deployment variables through the hosting provider's environment settings.

## Database schema

The current source cooldown table is defined in [`migrations/001-source-cooldowns.sql`](migrations/001-source-cooldowns.sql). Apply the migration when setting up a fresh Neon database.

## Health and API

- **Social previews:** Open Graph and Twitter/X metadata use the branded generated `public/og-card.png` image (source artwork: `public/og-card.svg`).
- **Application/database health:** [`/api/health`](https://instagram-mp3-downloader.vercel.app/api/health).
- **Badge data:** [`/api/health/badge`](https://instagram-mp3-downloader.vercel.app/api/health/badge).
- **Build workflow:** [GitHub Actions](https://github.com/Judson-web/Instagram-MP3-downloader/actions/workflows/ci.yml).

The service health check confirms the app can connect to its database. It does not guarantee that the upstream social-media source is available.

## Security

The deployment applies a nonce-based Content Security Policy, HSTS, anti-framing controls, MIME-sniffing protection, a restrictive Permissions Policy, and cross-origin response policies. Visitor rate-limit identifiers are truncated to an IPv4 `/24` or IPv6 `/64` network prefix, then pseudonymized using keyed HMAC-SHA-256 with a production secret of at least 32 bytes. Raw client IPs and truncated network prefixes are not stored as rate-limit keys.

The `reeltone_source_cooldowns` table keeps upstream rate-limit cooldowns shared across Vercel instances. When a source returns a 429, ReelTone honors `Retry-After` when available, otherwise applies an escalating cooldown, sends a `Retry-After` response header, and disables repeated user retries until the cooldown expires. This reduces needless requests; it does not bypass limits enforced by Instagram or a media provider. The server also validates submitted URLs and constrains media processing.

These safeguards reduce exposure but cannot make a public website perfectly secure. Keep dependencies updated and review configuration changes before deploying.

## Responsible use

Use public links only. Private or login-gated media may not be available. Download or reuse audio only when you have permission to do so. ReelTone is an independent project and is not affiliated with Instagram or Meta.

## License

ReelTone is distributed under the [Apache License 2.0](LICENSE).
