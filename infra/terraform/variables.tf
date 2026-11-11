variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "vertex_region" {
  description = "Vertex AI で Claude を呼ぶリージョン（global 推奨）"
  type        = string
  default     = "global"
}

variable "firestore_location" {
  type    = string
  default = "asia-northeast1"
}

variable "runner_image" {
  description = "例: asia-northeast1-docker.pkg.dev/PROJECT/agent-sandbox/runner:latest"
  type        = string
}

variable "gateway_image" {
  type = string
}

variable "claude_model" {
  description = "Claude Code が使うモデル（Vertex AI のモデル ID）"
  type        = string
  default     = "claude-opus-5-5"
}

variable "max_agent_turns" {
  type    = number
  default = 50
}

variable "turn_timeout_seconds" {
  description = "1 ターン（ユーザー 1 メッセージ）あたりの最大実行時間。Cloud Run の上限は 3600 秒"
  type        = number
  default     = 1800
}

variable "runner_cpu" {
  description = "ビルド（tsc / npm install / pip install）を行うので 4 以上推奨"
  type        = string
  default     = "4"
}

variable "runner_memory" {
  description = "Cloud Run のファイルシステムはメモリ上にある。node_modules / .venv もここを消費する"
  type        = string
  default     = "8Gi"
}

variable "runner_min_instances" {
  type    = number
  default = 0
}

variable "runner_max_instances" {
  description = "同時に実行できるターン数の上限（= コスト上限の目安）"
  type        = number
  default     = 10
}

variable "package_mirror" {
  description = "Artifact Registry のリモートリポジトリで npm / PyPI のミラーを作り、Runner から使えるようにする"
  type        = bool
  default     = true
}

variable "runner_internet_access" {
  description = "true にすると Runner からインターネットへ出られる（npm/pip 等）。既定は Google API のみ"
  type        = bool
  default     = false
}

variable "state_retention_days" {
  description = "セッションフォルダ（ファイル）を GCS に保持する日数"
  type        = number
  default     = 30
}

variable "allowed_models" {
  description = "リクエストで指定を許可するモデル（未指定なら claude_model を使う）"
  type        = list(string)
  default     = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
}

variable "auth_mode" {
  description = "iam（Cloud Run IAM、GCP 内のバックエンドから呼ぶ場合に推奨） | token（Bearer トークン）"
  type        = string
  default     = "iam"
  validation {
    condition     = contains(["iam", "token"], var.auth_mode)
    error_message = "auth_mode must be iam or token"
  }
}

variable "invoker_members" {
  description = "auth_mode=iam のとき Gateway を呼べるメンバー（例: serviceAccount:chat-backend@PROJECT.iam.gserviceaccount.com）"
  type        = list(string)
  default     = []
}

variable "api_token_secret" {
  description = "auth_mode=token のとき、API トークンを格納した Secret Manager のシークレット名"
  type        = string
  default     = "agent-sandbox-api-token"
}
