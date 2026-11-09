#!/usr/bin/env bash
# Runs actionlint on .github/workflows/ (CI and the pre-push hook). The release binary is
# downloaded once into node_modules/.cache and verified against the SHA-256 pinned below.
# To upgrade: bump VERSION and replace the hashes from actionlint_<VERSION>_checksums.txt
# of https://github.com/rhysd/actionlint/releases/latest.
set -euo pipefail

VERSION=1.7.12

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux_amd64 sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  Linux-aarch64 | Linux-arm64) platform=linux_arm64 sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
  Darwin-x86_64) platform=darwin_amd64 sha=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
  Darwin-arm64) platform=darwin_arm64 sha=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  *)
    echo "actionlint: unsupported platform $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

root="$(git rev-parse --show-toplevel)"
bin="$root/node_modules/.cache/actionlint/$VERSION/actionlint"

if [[ ! -x "$bin" ]]; then
  archive="actionlint_${VERSION}_${platform}.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$archive" \
    "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${archive}"
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"
  fi
  if [[ "$actual" != "$sha" ]]; then
    echo "actionlint: checksum mismatch for $archive (expected $sha, got $actual)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$bin")"
  tar -xzf "$tmp/$archive" -C "$(dirname "$bin")" actionlint
fi

cd "$root"
exec "$bin" "$@"
