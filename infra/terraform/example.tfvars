project_id    = "your-gcp-project"
region        = "asia-northeast1"
runner_image  = "asia-northeast1-docker.pkg.dev/your-gcp-project/agent-sandbox/runner:latest"
gateway_image = "asia-northeast1-docker.pkg.dev/your-gcp-project/agent-sandbox/gateway:latest"

# iam  : GCP 上のチャットボットのバックエンドから呼ぶ（推奨）
# token: GCP 外（Azure 等）から Authorization: Bearer <token> で呼ぶ
auth_mode       = "iam"
invoker_members = ["serviceAccount:chat-backend@your-gcp-project.iam.gserviceaccount.com"]
# auth_mode = "token"

runner_internet_access = false
