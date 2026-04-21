#!/usr/bin/env bash
# reduced-scope runner for claude-lsp-direct hook tests only
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
python3 -m pytest -q test_enforce_lsp_over_grep.py test_enforce_lsp_workspace_root.py "$@"
