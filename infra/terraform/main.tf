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

data "google_project" "this" {}

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

# Gateway: Firestore / GCS（状態）/ Runner 呼び出し / 署名付き URL 発行
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

# 署名付き URL を IAM signBlob で発行するため、Gateway SA が自分自身のトークン作成者になる
resource "google_service_account_iam_member" "gateway_self_sign" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.gateway.email}"
}

# ------------------------------------------------------------------ state storage

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

# ------------------------------------------------------------------ gateway (public API + chat UI)

resource "google_cloud_run_v2_service" "gateway" {
  name                = "agent-sandbox-gateway"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  iap_enabled         = var.auth_mode == "iap"
  launch_stage        = var.auth_mode == "iap" ? "BETA" : null

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

# token / none モードでは Cloud Run 自体は公開し、アプリ側で認証する。
# iap モードでは IAP が認証するので allUsers は付けない。
resource "google_cloud_run_v2_service_iam_member" "gateway_public" {
  count    = var.auth_mode == "iap" ? 0 : 1
  name     = google_cloud_run_v2_service.gateway.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_secret_manager_secret_iam_member" "gateway_token" {
  count     = var.auth_mode == "token" ? 1 : 0
  secret_id = var.api_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}

# IAP モード: 利用を許可するユーザー/グループ
resource "google_iap_web_cloud_run_service_iam_member" "users" {
  for_each               = var.auth_mode == "iap" ? toset(var.iap_members) : toset([])
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.gateway.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}

# IAP サービスエージェントが Gateway を invoke できるようにする
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  count    = var.auth_mode == "iap" ? 1 : 0
  name     = google_cloud_run_v2_service.gateway.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
}
