project_id    = "your-gcp-project"
region        = "asia-northeast1"
runner_image  = "asia-northeast1-docker.pkg.dev/your-gcp-project/agent-sandbox/runner:latest"
gateway_image = "asia-northeast1-docker.pkg.dev/your-gcp-project/agent-sandbox/gateway:latest"

# token: Authorization: Bearer <token> で認証（Secret Manager に事前登録）
# iap  : Google アカウントでログイン（iap_members に許可ユーザーを列挙）
auth_mode = "token"
# auth_mode   = "iap"
# iap_members = ["user:you@example.com"]

runner_internet_access = false
