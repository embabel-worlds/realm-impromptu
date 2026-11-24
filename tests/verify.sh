#!/bin/sh
# The realm's battery: tests/verify.py, which says what it checks. Its last line on success is
# exactly `ALL CHECKS PASS`, and any failure exits non-zero.
#
#   APPLIANCE=http://127.0.0.1:11043 AUTH=user:pass sh tests/verify.sh
#
# Needs no source key. APPLIANCE_URL with EMBABEL_USER and EMBABEL_PASSWORD work as well.
exec python3 "$(dirname "$0")/verify.py"
