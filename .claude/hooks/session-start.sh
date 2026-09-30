#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (ephemeral containers).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Cloudflare CLI (beta): https://developers.cloudflare.com/cf/
if ! command -v cf >/dev/null 2>&1; then
  npm install -g cf >&2
fi
