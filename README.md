# ReelTone

A focused web app for converting publicly accessible Instagram Reels and video posts into MP3 audio.

[![Website](https://img.shields.io/website?url=https%3A%2F%2Finstagramreeltomp3converter.vercel.app&label=website)](https://instagramreeltomp3converter.vercel.app/)
[![Service health](https://img.shields.io/endpoint?url=https%3A%2F%2Finstagramreeltomp3converter.vercel.app%2Fapi%2Fhealth%2Fbadge)](https://instagramreeltomp3converter.vercel.app/api/health)
[![CI](https://github.com/Judson-web/Instagram-MP3-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/Judson-web/Instagram-MP3-downloader/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/github/license/Judson-web/Instagram-MP3-downloader)](LICENSE)
[![TypeScript](https://img.shields.io/badge/source-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Vercel](https://img.shields.io/badge/hosted%20on-Vercel-black?logo=vercel&logoColor=white)](https://vercel.com/)

**Live site:** https://instagramreeltomp3converter.vercel.app/

## Features

- Convert publicly accessible Reel and video-post URLs into MP3.
- Choose 128, 192, 256, or 320 kbps.
- Embed title and creator ID3 tags in downloaded MP3s, plus Reel cover art when Instagram exposes a safe, public thumbnail. Artwork lookup is best-effort on the primary provider too, with a short timeout so it never blocks an otherwise valid download.
- Cache successful MP3s privately for up to 24 hours, allowing repeats to bypass Instagram extraction while keeping cached objects private.
- Use yt-dlp's metadata and thumbnail post-processors as part of the independent extractor fallback.
- Use the latest stable `gallery-dl` extractor as an independent public-media fallback. When Cobalt reports Instagram's `error.api.fetch.rate` or a shared Instagram cooldown is active, make one gallery-dl-only attempt on the separate extractor service rather than replaying GraphQL, HTML, and both yt-dlp profiles.
- During an active Instagram cooldown, reuse private cached output first, then try configured external providers while direct Instagram fetches remain paused.
- Compact, keyboard-accessible bitrate picker with four presets and concise quality labels.
- Light and dark themes with a remembered preference.
- Temporary browser download that expires after ten minutes.
- Clear, specific messages for invalid or unavailable links.
- Responsive desktop and mobile layouts.
- Search metadata, social sharing metadata, a branded 1200 × 630 Open Graph/Twitter preview card (PNG generated from the editable SVG source during build), and structured data.
- Application health endpoint and live status badge.

## Technology

- **Application:** TypeScript, Node.js, Express
- **Audio:** FFmpeg, yt-dlp metadata/thumbnail post-processors, and an optional dedicated Cobalt extractor fallback
- **Database:** Neon Postgres
- **Deployment:** Vercel
- **Checks:** TypeScript compiler, Node.js privacy unit tests, and GitHub Actions

TypeScript is the maintained application source, including the preview-image build step. Browser and Node.js runtime JavaScript plus the PNG preview are generated during the build and excluded from source control. The TypeScript compiler runs with `strict: true`, including strict-null and implicit-any checks.

## Local development

Requirements: Node.js 22 or later and a Neon Postgres database. Optional extractor providers are configured through environment variables; the application never hardcodes their hostnames.

1. Clone this repository.
2. Install dependencies with `npm install`.
3. Set `DATABASE_URL` to your Neon connection string.
4. Set `RATE_LIMIT_SECRET` to a cryptographically random value of at least 32 bytes.
Optional: `IMPERSONATED_YTDLP_API_URL` and `IMPERSONATED_YTDLP_API_TOKEN` enable an independent Render-hosted Python `yt-dlp[default,curl-cffi]` extractor. It uses browser impersonation without login cookies, accepts only public Instagram post URLs, and is invoked after the dedicated Cobalt instances fail. See the "Impersonated extractor service" section for deployment details.

5. Optionally set `COBALT_API_URL` and `COBALT_API_KEY_V2` (or the compatibility alias `COBALT_API_KEY`) for a dedicated Cobalt API instance. When configured, Cobalt is tried first and receives the submitted Instagram URL. Set `COBALT_API_FALLBACK_URLS` to a comma- or newline-separated list of additional HTTPS Cobalt instances that accept the same key; ReelTone tries these only after a retryable transport or media-download failure. Configure only instances you control or trust. `MEDIA_RESOLVER_URL` and `EASYDOWN_API_TOKEN` enable additional optional providers at later fallback stages; leave those unset unless you trust their data-handling policies.
6. Run `npm run check` to type-check the application.
7. Run `npm test` to verify IP anonymization behavior.
8. Run `npm run build` to test and compile the TypeScript runtime files.
9. Run `npm start` and open http://localhost:3000.

Keep environment files and secret values out of Git. Configure deployment variables through the hosting provider's environment settings.

## Database schema

The current source cooldown table is defined in [`migrations/001-source-cooldowns.sql`](migrations/001-source-cooldowns.sql). Apply the migration when setting up a fresh Neon database.

## Health and API

- **Social previews:** Open Graph and Twitter/X metadata use the branded generated `public/og-card.png` image (source artwork: `public/og-card.svg`).
- **Application/database health:** [`/api/health`](https://instagramreeltomp3converter.vercel.app/api/health).
- **Badge data:** [`/api/health/badge`](https://instagramreeltomp3converter.vercel.app/api/health/badge).
- **Build workflow:** [GitHub Actions](https://github.com/Judson-web/Instagram-MP3-downloader/actions/workflows/ci.yml).

The service health check confirms the app can connect to its database. It does not guarantee that the upstream social-media source is available.

## Resolver and URL privacy

When `COBALT_API_URL` and a Cobalt API key are configured, ReelTone tries that dedicated extractor first and sends it the submitted Instagram URL. The optional `COBALT_API_FALLBACK_URLS` list adds failover instances that accept the same key; a secondary instance is tried only when the previous one encounters a transport or media-download failure, not to evade explicit rate limits or source restrictions. Use only instances you control or trust and review their data-handling policies.

The generic media resolver is disabled unless `MEDIA_RESOLVER_URL` is configured to a trusted HTTPS endpoint. The optional EasyDown integration requires `EASYDOWN_API_TOKEN`. Each enabled provider receives the submitted URL when its fallback stage is reached. If those stages are not configured or unavailable, ReelTone continues with public Instagram page/embed parsing and the local yt-dlp/FFmpeg path. Provider health does not guarantee that Instagram will expose a playable stream for every public-looking link.

MP3 download filenames contain a UTC timestamp and random suffix, helping avoid collisions between files with identical titles.

## Security

The deployment applies a nonce-based Content Security Policy, HSTS, anti-framing controls, MIME-sniffing protection, a restrictive Permissions Policy, and cross-origin response policies. Visitor rate-limit identifiers are truncated to an IPv4 `/24` or IPv6 `/64` network prefix, then pseudonymized using keyed HMAC-SHA-256 with a production secret of at least 32 bytes. Raw client IPs and truncated network prefixes are not stored as rate-limit keys.

The `reeltone_source_cooldowns` table keeps upstream rate-limit cooldowns shared across Vercel instances. When a source returns a 429, ReelTone honors `Retry-After` when available, otherwise applies an escalating cooldown, sends a `Retry-After` response header, and disables repeated user retries until the cooldown expires. This reduces needless requests; it does not bypass limits enforced by Instagram or a media provider. The server also validates submitted URLs and constrains media processing.

These safeguards reduce exposure but cannot make a public website perfectly secure. Keep dependencies updated and review configuration changes before deploying.

## Responsible use

Use public links only. Private or login-gated media may not be available. Download or reuse audio only when you have permission to do so. ReelTone is an independent project and is not affiliated with Instagram or Meta.

## License

ReelTone is distributed under the [Apache License 2.0](LICENSE).


## Impersonated extractor service

Deploy a Render Docker web service from this repository using `Dockerfile.extractor` (Docker runtime). Set `REELTONE_EXTRACTOR_TOKEN` to a strong random shared secret. The service validates URLs independently, disables the public API docs, caps source duration and size, and returns MP3 bytes directly. Configure the identical value as `IMPERSONATED_YTDLP_API_TOKEN` in Vercel and set `IMPERSONATED_YTDLP_API_URL` to the service root.

**Optional instagrapi media path:** the extractor includes `instagrapi==3.1.0` and tries its authenticated media API before anonymous extraction only when a session is configured. Set one Render *secret* environment variable: `INSTAGRAPI_SETTINGS_JSON` (serialized settings from an instagrapi `Client.get_settings()` session), `INSTAGRAPI_SETTINGS_B64` (base64-encoded settings JSON), or `INSTAGRAPI_SESSIONID` (a session ID accepted by the private API). The session must belong to an account the operator is authorized to use. Never put session values in browser code, Git, logs, or ChatGPT. Prefer reusable instagrapi settings over a raw session ID; session cookies can expire or be revoked. This path rejects private-account media and gets its own cooldown after a rate limit. If no session is configured, anonymous extractors remain available.


## Reliability and caching

Successful MP3 outputs under 35 MiB are cached in the connected **private Vercel Blob store** for 24 hours, keyed by the canonical Reel URL and bitrate. Cache hits are served before checking Instagram's shared cooldown, so users can re-download previously converted audio even while Instagram is limiting new extraction. Cached audio is not exposed through a public Blob URL.

The converter counts visitor requests, then checks the private success cache, and only contacts extractors on a cache miss. When the dedicated Render `yt-dlp + curl-cffi` service is configured, the standalone non-impersonating binary is skipped because it duplicated upstream requests and was the final cause of avoidable 429s. Secondary Cobalt is attempted only on retryable transport/download failures, not HTTP 400. The two HTML/embed fallbacks remain available.

Vercel Cron runs `/api/maintenance/purge-audio-cache` daily and requires `CRON_SECRET`. The route deletes expired private MP3 and metadata objects. The Blob SDK dependency is pinned to `@vercel/blob@2.8.2`.

**Third-party extractor note:** ReelTone invokes `gallery-dl` as a separate command-line process. It is GPL-2.0 licensed; follow its upstream license and source-notice requirements when redistributing an image/container that includes it.
