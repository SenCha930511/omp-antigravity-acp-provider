#!/bin/sh
set -eu

if [ -z "${AGY_ACP_BIN:-}" ]; then
  AGY_ACP_BIN="${HOME}/.local/opt/agy-acp/current/agy_acp_server.par"
fi
if [ ! -x "${AGY_ACP_BIN}" ]; then
  printf 'Managed ACP executable is missing or not executable: %s\n' "${AGY_ACP_BIN}" >&2
  exit 1
fi
export AGY_ACP_BIN
exec omp "$@"
