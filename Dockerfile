# Recap Studio — single container for Hugging Face Spaces (Docker SDK).
# One process serves both the API and the built client on one URL.
FROM node:22-bookworm-slim

# fontconfig: libass (inside the bundled static ffmpeg) needs a fonts.conf to
# initialise even though captions load their fonts from server/fonts.
# yt-dlp: the official standalone Linux build, for URL downloads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

# Spaces run the container as uid 1000 — the image's built-in "node" user.
USER node
WORKDIR /home/node/app

# Dependencies first, so code-only changes rebuild fast.
COPY --chown=node server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY --chown=node client/package*.json client/
RUN cd client && npm ci

COPY --chown=node . .
RUN cd client && npm run build

# yt-dlp merges YouTube's separate video/audio streams with ffmpeg from PATH —
# point it at the same bundled binaries the app itself uses.
USER root
RUN chmod +x server/node_modules/ffprobe-static/bin/linux/x64/ffprobe \
 && ln -s /home/node/app/server/node_modules/ffmpeg-static/ffmpeg /usr/local/bin/ffmpeg \
 && ln -s /home/node/app/server/node_modules/ffprobe-static/bin/linux/x64/ffprobe /usr/local/bin/ffprobe
USER node

# Build-time smoke test: renders both modes end to end with blur, ratio and
# burned-in Burmese captions. No API keys or network needed. If ffmpeg, libass
# or the fonts don't work on Linux, the build fails here instead of deploying.
RUN cd server && node tools/verify.js && rm -rf uploads/verify

ENV NODE_ENV=production PORT=7860
EXPOSE 7860
WORKDIR /home/node/app/server
CMD ["node", "index.js"]
