#!/usr/bin/env bash

set -euo pipefail

COMMON_NAME=${1:-aice.local}
OUTPUT_DIR=${2:-./certs}
KEY_FILE="${OUTPUT_DIR}/${COMMON_NAME}.key"
CERT_FILE="${OUTPUT_DIR}/${COMMON_NAME}.crt"

mkdir -p "${OUTPUT_DIR}"

openssl req \
  -x509 \
  -nodes \
  -days 365 \
  -newkey rsa:2048 \
  -keyout "${KEY_FILE}" \
  -out "${CERT_FILE}" \
  -subj "/CN=${COMMON_NAME}"

echo "Generated:"
echo "  Key : ${KEY_FILE}"
echo "  Cert: ${CERT_FILE}"
