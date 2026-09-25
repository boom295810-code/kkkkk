---
title: K Recap
emoji: 🎬
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
short_description: Burmese voice-over and captions for any video
---

# Recap Studio

A web-based video and audio editing tool that automatically extracts audio, transcribes, translates, and generates Burmese Text-to-Speech (TTS) mixed back into the video.

(The block above is Hugging Face Spaces configuration — leave it at the top of this file.)

## Local Development
1. Run `npm install` in the root folder to install dependencies for both client and server.
2. In the `server` folder, copy `.env.example` to `.env` and fill in your API keys.
3. Start the application:
   - Backend: `cd server && npm start` (or `node index.js`)
   - Frontend: `cd client && npm run dev`

## Deployment (Hugging Face Spaces)
The `Dockerfile` builds one container that serves the API and the client on
one URL, and runs `server/tools/verify.js` during the build as a smoke test.

- Space secrets: `ASSEMBLYAIKEY` and `GEMINIKEY`. There is no login — anyone
  with the link can use the app (and the API credits behind those keys).
- Deploy or update: `powershell -File deploy-hf.ps1 -Space <user>/<space-name>`
  from this folder. It pushes exactly what is committed, with binaries in LFS.
- Free Spaces sleep after 48 h without use and lose rendered files on restart —
  download results when a job finishes.
