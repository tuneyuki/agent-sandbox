#!/usr/bin/env bash
# 使い方:
#   PROJECT_ID=my-proj AUTH_MODE=iam INVOKER=serviceAccount:chat-backend@my-proj.iam.gserviceaccount.com ./scripts/deploy.sh
#   PROJECT_ID=my-proj AUTH_MODE=token ./scripts/deploy.sh
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID を指定してください}"
REGION="${REGION:-asia-northeast1}"
AUTH_MODE="${AUTH_MODE:-iam}"
INVOKER="${INVOKER:-}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/agent-sandbox"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF="${ROOT}/infra/terraform"

gcloud config set project "$PROJECT_ID" >/dev/null

# 1) token モードなら API トークンを Secret Manager に用意
if [[ "$AUTH_MODE" == "token" ]]; then
  gcloud services enable secretmanager.googleapis.com
  if ! gcloud secrets describe agent-sandbox-api-token >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
    printf '%s' "$TOKEN" | gcloud secrets create agent-sandbox-api-token --data-file=-
    echo ">>> API トークンを作成しました（チャットボットのバックエンドに設定）: $TOKEN"
  fi
fi

VARS=(-var "project_id=${PROJECT_ID}" -var "region=${REGION}" -var "auth_mode=${AUTH_MODE}"
      -var "runner_image=${REPO}/runner:${TAG}" -var "gateway_image=${REPO}/gateway:${TAG}")
if [[ -n "$INVOKER" ]]; then VARS+=(-var "invoker_members=[\"${INVOKER}\"]"); fi

terraform -chdir="$TF" init -input=false

# 2) API 有効化と Artifact Registry だけ先に作る
terraform -chdir="$TF" apply -input=false -auto-approve "${VARS[@]}" \
  -target=google_project_service.apis -target=google_artifact_registry_repository.repo

# 3) イメージをビルド（Cloud Build）
gcloud builds submit "${ROOT}/runner"  --tag "${REPO}/runner:${TAG}"
gcloud builds submit "${ROOT}/gateway" --tag "${REPO}/gateway:${TAG}"

# 4) 残りを作成・更新
terraform -chdir="$TF" apply -input=false "${VARS[@]}"

echo
echo "Gateway URL: $(terraform -chdir="$TF" output -raw gateway_url)"
