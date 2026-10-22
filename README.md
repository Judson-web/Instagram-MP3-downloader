# ReelTone

A URL-first Instagram Reel to MP3 converter. Paste a public Instagram video URL, choose a bitrate, and download the extracted audio.

## Stack

- Node.js + Express API
- yt-dlp for retrieving supported public video URLs
- FFmpeg for MP3 extraction and encoding
- Docker for a consistent deployment environment
- Render for hosting, with automatic deployment from `main`

## Features

- URL-first workflow; no local video upload flow
- 128, 192, and 320 kbps MP3 output choices
- Live job progress, cancel support, and direct MP3 download
- Public Instagram Reel and video-post URLs
- Temporary job files with automatic cleanup
- Per-IP request limits and a single active conversion by default
- URL and hostname validation, request-size limits, Helmet security headers, and no credential/cookie collection
- Responsive, accessible UI with reduced-motion support

## Run locally

Requirements: Node.js 20+, Python 3.10+, and FFmpeg installed on the machine.

1. Install Node dependencies: `npm install`
2. Install yt-dlp: `python3 -m pip install yt-dlp`
3. Start the service: `npm start`
4. Open `http://localhost:3000`

To check JavaScript syntax, run `npm run check`.

## Docker

```sh
docker build -t reeltone .
docker run --rm -p 10000:10000 -e PORT=10000 reeltone
```

## Deploy to Render

The repository contains a `Dockerfile` and `render.yaml` Blueprint. Connect the repository to Render and create the service from the Blueprint. Render can then build the image and automatically redeploy when `main` changes. The service health endpoint is `/api/health`.

The free service plan may spin down while idle, so the first request after a quiet period can take longer. Increase the Render plan and resource limits if the site needs sustained usage or more concurrent jobs.

## API

- `GET /api/health` — service health
- `POST /api/convert` — body: `{"url":"https://www.instagram.com/reel/SHORTCODE/","quality":"192"}`; returns a `jobId`
- `GET /api/jobs/:id` — poll job status and conversion progress
- `GET /api/jobs/:id/download` — download the completed MP3
- `DELETE /api/jobs/:id` — cancel a running conversion

Supported quality values are `128`, `192`, and `320`. By default, videos longer than 10 minutes are rejected, each IP is limited to 8 conversion requests per hour, and the service processes one conversion at a time. Jobs and temporary MP3 files expire after 15 minutes.

## Notes

Instagram availability varies; some public posts may still be unavailable to third-party tools. ReelTone does not request Instagram passwords, read browser sessions, or attempt to access private/login-gated media. A conversion may fail when the source cannot be retrieved publicly.

Only download or reuse audio you have permission to use. This project is independent and is not affiliated with Instagram or Meta.

## License

MIT