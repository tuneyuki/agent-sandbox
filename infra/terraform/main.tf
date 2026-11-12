terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  services = [
    "run.googleapis.com",
    "aiplatform.googleapis.com",
    "firestore.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "compute.googleapis.com",
    "dns.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# ------------------------------------------------------------------ images

resource "google_artifact_registry_repository" "repo" {
  repository_id = "agent-sandbox"
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# ------------------------------------------------------------------ service accounts

# Gateway: Firestore / GCS バケット全体 / Runner 呼び出し / セッション限定トークンの発行
resource "google_service_account" "gateway" {
  account_id   = "agent-sandbox-gateway"
  display_name = "Agent Sandbox Gateway"
}

# Runner: Vertex AI で Claude を呼ぶ権限「だけ」。GCS や Firestore の権限は付けない。
# （エージェントは Bash からメタデータサーバー経由でこの SA のトークンを取得できるため）
resource "google_service_account" "runner" {
  account_id   = "agent-sandbox-runner"
  display_name = "Agent Sandbox Runner (Claude Code)"
}

resource "google_project_iam_member" "runner_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_project_iam_member" "gateway_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# ------------------------------------------------------------------ session storage
# バケットは 1 つだけ。sessions/{sessionId}/ のフォルダでセッションを論理的に分ける。
#   sessions/{id}/workspace/**         ユーザーのファイル + エージェントの成果物
#   sessions/{id}/.state/claude.tar.gz Claude Code の会話記録
# Runner には sessions/{id}/ だけに絞ったダウンスコープトークン（Credential Access Boundary）を渡す。

resource "google_storage_bucket" "state" {
  name                        = "${var.project_id}-agent-sandbox-state"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  lifecycle_rule {
    condition { age = var.state_retention_days }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "gateway_state" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_firestore_database" "db" {
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]
}

# countRunning: where status == running and lockedUntil > now
resource "google_firestore_index" "sessions_running" {
  database   = google_firestore_database.db.name
  collection = "sessions"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "lockedUntil"
    order      = "ASCENDING"
  }
}

# listSessions: where owner == x order by updatedAt desc
resource "google_firestore_index" "sessions_by_owner" {
  database   = google_firestore_database.db.name
  collection = "sessions"
  fields {
    field_path = "owner"
    order      = "ASCENDING"
  }
  fields {
    field_path = "updatedAt"
    order      = "DESCENDING"
  }
}

# ------------------------------------------------------------------ runner (sandbox)
# 1 ターン = Cloud Run Jobs の 1 実行。HTTP 接続に縛られないので、呼び出し元が切断しても
# 処理は続き、1 ターンの上限も最大 24 時間まで延ばせる。
# Gateway が実行ごとに SESSION_ID / TURN_ID / TURN_TOKEN / CALLBACK_URL を上書きして起動する。

resource "google_cloud_run_v2_job" "runner" {
  name                = "agent-sandbox-runner"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account       = google_service_account.runner.email
      timeout               = "${var.turn_timeout_seconds + 900}s"
      max_retries           = 0 # 失敗したターンを勝手にやり直さない
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.sandbox.id
          subnetwork = google_compute_subnetwork.sandbox.id
          tags       = ["agent-sandbox-runner"]
        }
        egress = "ALL_TRAFFIC" # 全通信を VPC に通し、ファイアウォールで制限する
      }

      containers {
        image = var.runner_image
        resources {
          limits = {
            cpu    = var.runner_cpu
            memory = var.runner_memory
          }
        }
        env {
          name  = "CLAUDE_CODE_USE_VERTEX"
          value = "1"
        }
        env {
          name  = "CLOUD_ML_REGION"
          value = var.vertex_region
        }
        env {
          name  = "ANTHROPIC_VERTEX_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "CLAUDE_MODEL"
          value = var.claude_model
        }
        env {
          name  = "MAX_TURNS"
          value = tostring(var.max_agent_turns)
        }
        env {
          name  = "NPM_MIRROR_URL"
          value = local.npm_mirror_url
        }
        env {
          name  = "PYPI_MIRROR_URL"
          value = local.pypi_mirror_url
        }
        env {
          # Bash と、そこから起動したアプリを bubblewrap で隔離し、通信をパッケージミラーだけに絞る
          name  = "COMMAND_SANDBOX"
          value = var.command_sandbox ? "1" : "0"
        }
        env {
          # Web 検索は Gemini の Google Search grounding だけを使う（サンドボックス自体はインターネット禁止のまま）
          name  = "GROUNDING_ENABLED"
          value = var.gemini_grounding ? "1" : "0"
        }
        env {
          name  = "GROUNDING_MODEL"
          value = var.grounding_model
        }
        env {
          name  = "GROUNDING_LOCATION"
          value = var.grounding_location
        }
        env {
          # Gateway が IAM 認証のとき、報告に ID トークンを付ける
          name  = "CALLBACK_USE_ID_TOKEN"
          value = var.auth_mode == "iam" ? "1" : "0"
        }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# Gateway が環境変数を上書きしてジョブを実行できるようにする
resource "google_cloud_run_v2_job_iam_member" "gateway_runs_runner" {
  name     = google_cloud_run_v2_job.runner.name
  location = var.region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

# ジョブは Runner の SA で動くため、起動する側（Gateway）にその SA を使う権限を与える
resource "google_service_account_iam_member" "gateway_acts_as_runner" {
  service_account_id = google_service_account.runner.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.gateway.email}"
}

# ------------------------------------------------------------------ gateway (API)

resource "google_cloud_run_v2_service" "gateway" {
  name                = "agent-sandbox-gateway"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.gateway.email
    # SSE の 1 接続の上限。長いターンはクライアントが Last-Event-ID で再接続して続きを受け取る
    timeout                          = "3600s"
    max_instance_request_concurrency = 80

    containers {
      image = var.gateway_image
      env {
        name  = "RUNNER_JOB"
        value = google_cloud_run_v2_job.runner.id
      }
      env {
        name  = "STATE_BUCKET"
        value = google_storage_bucket.state.name
      }
      env {
        name  = "AUTH_MODE"
        value = var.auth_mode
      }
      env {
        name  = "ALLOWED_MODELS"
        value = join(",", var.allowed_models)
      }
      env {
        name  = "TURN_TIMEOUT_MS"
        value = tostring(var.turn_timeout_seconds * 1000)
      }
      env {
        name  = "MAX_RUNNING_TURNS"
        value = tostring(var.max_running_turns)
      }
      dynamic "env" {
        for_each = var.auth_mode == "token" ? [1] : []
        content {
          name = "API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = var.api_token_secret
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# iam   : Cloud Run の IAM で認証。invoker_members（チャットボットのバックエンドの SA など）だけが呼べる
# token : Cloud Run 自体は公開し、アプリ側で Bearer トークンを検証（GCP 外のバックエンドから呼ぶ場合）
resource "google_cloud_run_v2_service_iam_member" "gateway_invokers" {
  # Runner は進捗報告のために Gateway を呼ぶので、iam モードでは Runner の SA も含める
  for_each = var.auth_mode == "iam" ? toset(concat(var.invoker_members, ["serviceAccount:${google_service_account.runner.email}"])) : toset(["allUsers"])
  name     = google_cloud_run_v2_service.gateway.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}

resource "google_secret_manager_secret_iam_member" "gateway_token" {
  count     = var.auth_mode == "token" ? 1 : 0
  secret_id = var.api_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}
