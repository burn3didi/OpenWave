#!/usr/bin/env bash
# Generates a few synthetic CC0 demo tracks so you can try the player right away.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p demo

gen() { # file title expression
  ffmpeg -nostdin -y -v error -f lavfi -i "$3" -t 24 \
    -metadata title="$2" -metadata artist="OpenWave Demo" -metadata album="Test Tones" \
    "demo/$1.wav"
}

gen 01-dawn      "Dawn"       "sine=frequency=261.63:sample_rate=44100,tremolo=f=0.4:d=0.6"
gen 02-drift     "Drift"      "sine=frequency=329.63:sample_rate=44100,vibrato=f=4:d=0.3"
gen 03-low-tide  "Low Tide"   "sine=frequency=110:sample_rate=44100,tremolo=f=0.25:d=0.8"
gen 04-glass     "Glass"      "sine=frequency=523.25:sample_rate=44100,tremolo=f=2:d=0.5"

echo "Demo tracks written to ./demo"
