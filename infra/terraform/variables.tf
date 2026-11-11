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
  type    = string
  default = "2"
}

variable "runner_memory" {
  type    = string
  default = "4Gi"
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

variable "runner_internet_access" {
  description = "true にすると Runner からインターネットへ出られる（npm/pip 等）。既定は Google API のみ"
  type        = bool
  default     = false
}

variable "state_retention_days" {
  description = "セッションの作業ディレクトリを GCS に保持する日数"
  type        = number
  default     = 30
}

variable "auth_mode" {
  description = "iap | token"
  type        = string
  default     = "token"
  validation {
    condition     = contains(["iap", "token"], var.auth_mode)
    error_message = "auth_mode must be iap or token"
  }
}

variable "api_token_secret" {
  description = "auth_mode=token のとき、API トークンを格納した Secret Manager のシークレット名"
  type        = string
  default     = "agent-sandbox-api-token"
}

variable "iap_members" {
  description = "auth_mode=iap のとき利用を許可するメンバー（例: user:alice@example.com, group:team@example.com）"
  type        = list(string)
  default     = []
}
