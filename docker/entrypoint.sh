#!/bin/sh
set -eu

# Named volumes are commonly created as root. Initialize them once, then drop
# privileges before the application reads credentials or opens SQLite files.
if [ "$(stat -c '%u:%g' /data)" != "10001:10001" ]; then
  chown -R loom:loom /data
fi

exec runuser -u loom -- "$@"
