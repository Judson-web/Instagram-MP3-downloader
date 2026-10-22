# ReelTone

ReelTone converts public Instagram Reel and video-post URLs into downloadable MP3 audio. The primary workflow is **paste a URL and receive an MP3**. There is no local video-upload flow.

## Stack

- Express on Vercel Fluid Compute
- Public Reel HTML/CDN media extraction with bounded size, redirect, and timeout checks
- FFmpeg via `ffmpeg-static` for MP3 encoding
- yt-dlp via `youtube-dl-exec` as a secondary extractor
- Neon Postgres for persistent per-IP rate limiting, storing a keyed hash rather than raw IP addresses

## Features

- Paste a public Instagram Reel URL
- Select 128, 192, or 320 kbps MP3 output
- Stream the completed MP3 directly from the conversion function to the browser
- Animated progress, cancellation, result state, and local browser download
- Host and path validation, request-size limits, safe headers, bounded duration, extraction timeout, and request throttling
- Automatic removal of temporary media from the function's scratch directory

## Local development

Requirements: Node.js 20+ and Python 3.9+ (for the yt-dlp executable installed by `youtube-dl-exec`).

1. Install dependencies with `npm install`.
2. Set `DATABASE_URL` to your dedicated Neon `reeltone` database connection string.
3. Set `RATE_LIMIT_SECRET` to a long random value.
4. Set `YOUTUBE_DL_FILENAME=yt-dlp_linux` and `YOUTUBE_DL_SKIP_PYTHON_CHECK=true` when building for the Linux standalone binary used on Vercel.
5. Run `npm start` and open `http://localhost:3000`.
6. Run `npm run check` for JavaScript syntax checks.

The app has an in-memory rate-limit fallback for local development if `DATABASE_URL` is omitted. Production should use Neon.

## Deploy on Vercel

The repository is configured to deploy as a Vercel Express application. Connect this repository to a **new** Vercel project named `instagram-mp3-downloader`. Do not reuse the Auto Redeemer project.

Set these environment variables for Production, Preview, and Development where appropriate:

- `DATABASE_URL`: connection string for the dedicated Neon database `reeltone`
- `RATE_LIMIT_SECRET`: a long, randomly generated secret used to hash visitor IPs
- `YOUTUBE_DL_FILENAME=yt-dlp_linux`
- `YOUTUBE_DL_SKIP_PYTHON_CHECK=true`

`vercel.json` includes the media binaries in the server function bundle and sets the 300-second maximum function duration. Vercel serves the files under `public/` from its CDN; Express handles the API. The serverless function region is configured for Mumbai (`bom1`) to keep the API close to users in India.

## Neon

Use the standalone Neon project named `instagram-mp3-converter` in Singapore. It is separate from the Kingshot databases. The `conversion_usage` table supports a per-IP hourly limit of eight conversions. Only an HMAC hash of the IP address is stored, with old buckets periodically deleted.

## API

- `GET /api/health` returns service health.
- `POST /api/convert` accepts JSON such as `{"url":"https://www.instagram.com/reel/SHORTCODE/","quality":"192"}` and responds with `audio/mpeg` when conversion succeeds, or a JSON error when it fails.

Valid quality values are `128`, `192`, and `320`. The default duration limit is 20 minutes, downloaded source media is capped at 150 MiB, and each IP is limited to eight attempts per hour. The direct-media path has bounded fetch/encode steps; the yt-dlp fallback is stopped after 50 seconds to leave time for the result to stream.

## Notes

Instagram availability changes, and its HTML/media delivery can differ for datacenter requests. ReelTone first checks for public video metadata in the Reel page and then tries yt-dlp; if neither can obtain a stream, it reports a recoverable error. It does not request Instagram passwords or attempt to access private media. Use audio you have permission to download or reuse.

ReelTone is independent and is not affiliated with Instagram or Meta.

## License

MIT
