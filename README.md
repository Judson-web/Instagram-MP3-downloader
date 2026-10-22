# ReelTone

ReelTone is a URL-first Instagram Reel to MP3 converter. Paste a public Reel or video-post link, choose an audio bitrate, and download an MP3. There is no local video-upload workflow.

## Stack

- TypeScript source for the Express backend and browser client
- Vercel for hosting and deployment
- Neon Postgres for persistent conversion rate limits
- FFmpeg (via `ffmpeg-static`) for MP3 encoding
- yt-dlp (via `youtube-dl-exec`) as a fallback extractor
- Public media-link resolver fallback when Instagram does not expose metadata to anonymous serverless requests

## Features

- 128, 192, or 320 kbps MP3 output
- Live progress feedback, cancel action, and a result/download card with Reel title and author when available
- Distinct statuses for explicitly private Reels, login-required media, upstream rate limits, missing/unavailable posts, oversized videos, long videos, service errors, and ambiguous “no public media” responses
- Safe host/path validation, allow-listed Instagram CDN hosts, request throttling, bounded download sizes, timeouts, and temporary-file cleanup
- No Instagram password or account-cookie collection

## Source layout

- `src/server.ts`: typed Express API, conversion pipeline, structured error codes, Neon rate limiting, health endpoint
- `src/client.ts`: typed browser interactions, validation, progress/error states, result metadata, MP3 downloads
- `public/index.html` and `public/styles.css`: responsive, accessible UI
- `tsconfig.json`: TypeScript compiler configuration
- `server.js` and `public/app.js`: generated JavaScript runtime artifacts created during the Vercel build

The generated JavaScript files are deployment outputs. Make code changes in `src/*.ts`, then run the build to regenerate them.

## Build and run locally

Requirements: Node.js 22+ and FFmpeg/yt-dlp binaries supplied by the npm dependencies.

1. Install dependencies: `npm install`.
2. Set `DATABASE_URL` to the dedicated Neon `reeltone` connection string.
3. Set `RATE_LIMIT_SECRET` to a long random value.
4. Set `YOUTUBE_DL_FILENAME=yt-dlp_linux` and `YOUTUBE_DL_SKIP_PYTHON_CHECK=true` for the standalone Linux yt-dlp executable in serverless builds.
5. Run `npm run check` to type-check the TypeScript sources.
6. Run `npm run build` to type-check, compile TypeScript, and generate `server.js` and `public/app.js`.
7. Run `npm start` and open `http://localhost:3000`.

For local development, the app falls back to an in-memory rate limiter if `DATABASE_URL` is omitted. Production should always be configured with Neon.

## Deploy

The Git repository is connected to the dedicated Vercel project `instagram-mp3-downloader`. Do not reuse the Kingshot Auto Redeemer project. The conversion function is pinned to Vercel's Mumbai region (`bom1`).

Environment variables for the ReelTone Vercel project:

- `DATABASE_URL`: connection string for the separate Neon `reeltone` database
- `RATE_LIMIT_SECRET`: random secret used to HMAC-hash visitor identifiers for rate limits
- `YOUTUBE_DL_FILENAME=yt-dlp_linux`
- `YOUTUBE_DL_SKIP_PYTHON_CHECK=true`

## Neon

ReelTone uses its own Neon project, `instagram-mp3-converter`, with database `reeltone`. It is separate from the Auto Redeemer data. The `conversion_usage` table stores HMAC-hashed IP identifiers and hourly request counts; raw IP addresses are not stored in the table.

## API

- `GET /api/health`: checks both the application and Neon database.
- `POST /api/convert`: accepts JSON such as `{"url":"https://www.instagram.com/reel/SHORTCODE/","quality":"192"}`. On success the response is `audio/mpeg`; on failure it returns a typed JSON error with `code`, `title`, `error`, `retryable`, and `category`.

Bitrate values are `128`, `192`, and `320`. The duration limit is 20 minutes, source downloads are capped at 150 MiB, each visitor is limited to eight attempts per hour, and media operations use bounded timeouts.

## Error classification

- `PRIVATE_REEL`: Instagram/resolver explicitly marks the Reel private.
- `LOGIN_REQUIRED`: a signed-in session is explicitly required.
- `INSTAGRAM_RATE_LIMITED`: the source or resolver is throttling anonymous requests.
- `REEL_UNAVAILABLE`: evidence points to a missing or removed post.
- `NO_PUBLIC_MEDIA`: Instagram provided no playable media but did not reveal why; the page explains that privacy, restrictions, removal, and temporary unavailability can look alike from an anonymous request.
- `VIDEO_TOO_LONG` / `VIDEO_TOO_LARGE`: explicit processing limits.
- `RATE_LIMITED`: ReelTone's own hourly limit.
- `DATABASE_UNAVAILABLE` / `RESOLVER_UNAVAILABLE` / `CONVERSION_TIMEOUT`: recoverable service conditions with separate messaging.

The converter does not claim a Reel is private unless the upstream evidence explicitly says so.

## External media lookup and privacy

If Instagram's public HTML does not expose video metadata, ReelTone requests public metadata from a third-party resolver. The resolved media URL is accepted only when it points to an allow-listed Instagram CDN host. The ReelTone Vercel function downloads the media to temporary storage and creates the MP3 with FFmpeg, then cleans up temporary files. No Instagram password, account cookie, or private-session token is collected.

Third-party resolver availability and Instagram delivery behavior can change. Only download or reuse audio you have permission to use. ReelTone is independent and is not affiliated with Instagram or Meta.

## License

MIT
