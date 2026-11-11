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

resource "google_cloud_run_v2_service" "runner" {
  name     = "agent-sandbox-runner"
  location = var.region
  # 外部から直接叩けないようにする（Gateway から VPC 経由 or 内部のみ）
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false

  template {
    service_account                  = google_service_account.runner.email
    timeout                          = "${var.turn_timeout_seconds + 300}s"
    max_instance_request_concurrency = 1 # 1 コンテナ = 1 ターン
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.runner_min_instances
      max_instance_count = var.runner_max_instances
    }

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
        cpu_idle = false
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
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_runner" {
  name     = google_cloud_run_v2_service.runner.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

# ------------------------------------------------------------------ gateway (API)

resource "google_cloud_run_v2_service" "gateway" {
  name                = "agent-sandbox-gateway"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.gateway.email
    timeout                          = "${var.turn_timeout_seconds + 120}s"
    max_instance_request_concurrency = 80

    # Runner は internal ingress なので、Gateway からの呼び出しを VPC 経由にする。
    # *.run.app / *.googleapis.com は private DNS で private.googleapis.com に向くため
    # ALL_TRAFFIC にして Private Google Access 経由で到達させる。
    vpc_access {
      network_interfaces {
        network    = google_compute_network.sandbox.id
        subnetwork = google_compute_subnetwork.gateway.id
      }
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = var.gateway_image
      env {
        name  = "RUNNER_URL"
        value = google_cloud_run_v2_service.runner.uri
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
  for_each = var.auth_mode == "iam" ? toset(var.invoker_members) : toset(["allUsers"])
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
