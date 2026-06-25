#!/bin/sh
export HOSTNAME=0.0.0.0
export PORT=${PORT:-3000}
node server.js
