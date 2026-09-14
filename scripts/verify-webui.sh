#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec npm --prefix "$repo_dir/webui" run agent:verify
