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
- Encode every download at one consistent 192 kbps MP3 bitrate.
- Embed title and creator ID3 tags in downloaded MP3s, plus Reel cover art when Instagram exposes a safe, public thumbnail. Artwork lookup is best-effort on the primary provider too, with a short timeout so it never blocks an otherwise valid download.
- Cache successful MP3s privately for up to 24 hours, allowing repeats to bypass Instagram extraction while keeping cached objects private.
- Use yt-dlp's metadata and thumbnail post-processors as part of the independent extractor fallback.
- Keep direct-source, Cobalt-instance, Apify, gallery-dl, and Instagrapi cooldowns independent so one limited provider does not suppress unrelated fallbacks.
- During an active Instagram cooldown, reuse private cached output first, then try configured external providers while direct Instagram fetches remain paused.
- A simple, single-quality interface with no bitrate picker.
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

When `COBALT_API_URL` and a Cobalt API key are configured, ReelTone tries that dedicated extractor first and sends it the submitted Instagram URL. `COBALT_API_FALLBACK_URLS` can add a separately hosted Cobalt instance. Each instance has its own cooldown; a direct Instagram cooldown no longer suppresses the Cobalt chain. Failover is bounded to the configured primary and one secondary, and is for reliability rather than proxy rotation.

The optional `APIFY_API_TOKEN` enables the official Apify Instagram Reel Scraper as an independent fallback when Cobalt and the Render extractor do not return playable media. It runs only on the server, accepts public Reel links, requests at most one item, caps each actor run to US$0.05, and downloads only media hosted by allow-listed Instagram CDN domains. The token is never sent to Instagram or to media CDN hosts. Apify is a paid service and its availability, output schema, and pricing can change; leave the variable unset to disable it.

The generic media resolver is disabled unless `MEDIA_RESOLVER_URL` is configured to a trusted HTTPS endpoint. The optional EasyDown integration requires `EASYDOWN_API_TOKEN`. Each enabled provider receives the submitted URL when its fallback stage is reached. Provider health does not guarantee Instagram will expose a playable stream for every public-looking link.

ReelTone produces a single MP3 output at **192 kbps**. Bitrate selection has been removed from the user interface and server requests are normalized to the same fixed output bitrate.

MP3 download filenames contain a UTC timestamp and random suffix, helping avoid collisions between files with identical titles.
## Security

The deployment applies a nonce-based Content Security Policy, HSTS, anti-framing controls, MIME-sniffing protection, a restrictive Permissions Policy, and cross-origin response policies. Visitor rate-limit identifiers are truncated to an IPv4 `/24` or IPv6 `/64` network prefix, then pseudonymized using keyed HMAC-SHA-256 with a production secret of at least 32 bytes. Raw client IPs and truncated network prefixes are not stored as rate-limit keys.

The `reeltone_source_cooldowns` table keeps upstream rate-limit cooldowns shared across Vercel instances. When a source returns a 429, ReelTone honors `Retry-After` when available, otherwise applies a short 60-second cooldown, sends a `Retry-After` response header, and keeps independent provider cooldowns separate. Historical exponentially escalated rows are clamped to a minute so they do not trap the service in a long legacy cooldown. This reduces needless requests; it does not bypass limits enforced by Instagram or a media provider. The server also validates submitted URLs and constrains media processing.

These safeguards reduce exposure but cannot make a public website perfectly secure. Keep dependencies updated and review configuration changes before deploying.

## Responsible use

Use public links only. Private or login-gated media may not be available. Download or reuse audio only when you have permission to do so. ReelTone is an independent project and is not affiliated with Instagram or Meta.

## License

ReelTone is distributed under the [Apache License 2.0](LICENSE).


## Impersonated extractor service

Deploy a Render Docker web service from this repository using `Dockerfile.extractor` (Docker runtime). Set `REELTONE_EXTRACTOR_TOKEN` to a strong random shared secret. The service validates URLs independently, disables the public API docs, caps source duration and size, and returns MP3 bytes directly. Configure the identical value as `IMPERSONATED_YTDLP_API_TOKEN` in Vercel and set `IMPERSONATED_YTDLP_API_URL` to the service root.

**Optional Instagrapi media path:** the Render extractor can use an authorized session for public-video metadata and media URLs before trying its anonymous fallbacks. It reuses one client per worker, keeps rotated settings in a private owner-only temporary file, and never forwards the account's private API cookies to Instagram's media CDN.

An Instagram `sessionid` is a revocable session credential, not a permanent API key. Instagram can expire it, revoke it, or require a security challenge. There is no supported way to make it immortal. ReelTone now cools down an invalid session and falls back to public extractors instead of hammering login endpoints.

For setup:

1. Use only an Instagram account you own or are authorized to use. You can provide a saved session settings file as `INSTAGRAPI_SETTINGS_B64` (preferred) or a browser `INSTAGRAPI_SESSIONID` as a compatibility bootstrap. Settings can be generated locally after a successful `instagrapi` login; never upload the JSON file to GitHub or send its contents in chat.
2. Add authentication material only in the [Render extractor environment settings](https://dashboard.render.com/web/srv-dbdelsnb9u1s739ej6cg/environment). Never put it in Vercel client-side variables, source code, logs, issue comments, or chat.
3. For **automatic renewal**, add these Render environment variables using the account owner’s own credentials:
   - `INSTAGRAPI_AUTO_REAUTH=true`
   - `INSTAGRAPI_USERNAME` = the account username
   - `INSTAGRAPI_PASSWORD` = the account password, stored as a Render secret
   The service reuses saved settings first and permits a bounded `Client.login()` renewal attempt when the saved session is rejected. It does not loop on password login; on a challenge, unsupported client response, or failed renewal, it cools down and keeps the anonymous public-media fallback available. Automatic renewal is best-effort because Instagram may reject password login or require human verification.
4. After saving environment changes, wait for Render to redeploy and check [extractor health](https://reeltone-impersonated-extractor.onrender.com/health). It exposes only safe flags such as whether a session is configured, the non-secret auth mode, and whether auto-renew is configured. These flags do not prove every media request will succeed.
5. Test one public Reel. The authenticated API metadata lookup tries bounded video-URL candidates; if a signed CDN URL returns `401/403`, the service refreshes metadata once and retries one new signed URL. The media download is still anonymous at the CDN layer, with host validation and file/duration caps. If the request is rate-limited, the service pauses rather than rotating sessions or repeating login attempts.

Private-account media is rejected. If Instagram presents a challenge, asks for a password reset, or reports that the client is unsupported, resolve that through the official Instagram app/site and do not retry repeatedly. The extractor is unofficial and depends on Instagram behavior, so session renewal and successful media availability cannot be guaranteed.

## Reliability and caching

Successful MP3 outputs under 35 MiB are cached in the connected **private Vercel Blob store** for 24 hours, keyed by the canonical Reel URL and bitrate. Cache hits are served before checking Instagram's shared cooldown, so users can re-download previously converted audio even while Instagram is limiting new extraction. Cached audio is not exposed through a public Blob URL.

The converter counts visitor requests, then checks the private success cache, and only contacts extractors on a cache miss. When the dedicated Render `yt-dlp + curl-cffi` service is configured, the standalone non-impersonating binary is skipped because it duplicated upstream requests and was the final cause of avoidable 429s. Secondary Cobalt is attempted only on retryable transport/download failures, not HTTP 400. The two HTML/embed fallbacks remain available.

Vercel Cron runs `/api/maintenance/purge-audio-cache` daily and requires `CRON_SECRET`. The route deletes expired private MP3 and metadata objects. The Blob SDK dependency is pinned to `@vercel/blob@2.8.2`.

**Third-party extractor note:** ReelTone invokes `gallery-dl` as a separate command-line process. It is GPL-2.0 licensed; follow its upstream license and source-notice requirements when redistributing an image/container that includes it.
