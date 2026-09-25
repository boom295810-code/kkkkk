# Deploy the committed state of this repo to a Hugging Face Space.
#
#   powershell -File deploy-hf.ps1 -Space <user>/<space-name>
#
# Uses `git archive HEAD`, so only committed files are sent — .env,
# settings.json, uploads and anything else gitignored can never leak.
# Binaries go through Git LFS (Hugging Face rejects them otherwise).
# The Space's own history is replaced on each deploy; this repo is the source
# of truth. Git asks for your Hugging Face username and an access token with
# write permission (huggingface.co/settings/tokens) the first time.
param(
  [Parameter(Mandatory = $true)][string]$Space
)
$ErrorActionPreference = 'Stop'

$repo = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw 'Run this from inside the recap-v3 git repo.' }
$dirty = git -C $repo status --porcelain
if ($dirty) { Write-Warning 'You have uncommitted changes. Only committed files are deployed.' }

$stage = Join-Path $env:TEMP ('hf-deploy-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $tar = Join-Path $stage 'src.tar'
  git -C $repo archive --format=tar -o $tar HEAD
  tar -xf $tar -C $stage
  Remove-Item $tar

  git -C $stage init -q -b main
  git -C $stage lfs install --local | Out-Null
  git -C $stage lfs track '*.ttf' '*.otf' '*.png' '*.jpg' '*.jpeg' '*.gif' '*.ico' '*.webp' '*.mp3' '*.mp4' '*.wav' '*.woff' '*.woff2' | Out-Null
  git -C $stage add -A
  $sha = git -C $repo rev-parse --short HEAD
  git -C $stage -c user.name='deploy' -c user.email='deploy@localhost' commit -q -m "Deploy $sha"
  git -C $stage push --force "https://huggingface.co/spaces/$Space" main
  if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
  Write-Host "Deployed $sha. Build log: https://huggingface.co/spaces/$Space?logs=build"
} finally {
  Remove-Item -Recurse -Force $stage
}
