# Runner の外向き通信を制御する VPC。
#
# runner_internet_access = false（既定）:
#   - Google API（Vertex AI）へは Private Google Access (private.googleapis.com) 経由のみ許可
#   - それ以外の外向き通信はすべて拒否 → npm install / pip install / 任意サイトへの通信は不可
# runner_internet_access = true:
#   - Cloud NAT を作り、外向き通信を許可（パッケージ取得や Web 取得が必要な用途向け）

resource "google_compute_network" "sandbox" {
  name                    = "agent-sandbox"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "sandbox" {
  name                     = "agent-sandbox-runner"
  network                  = google_compute_network.sandbox.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_subnetwork" "gateway" {
  name                     = "agent-sandbox-gateway"
  network                  = google_compute_network.sandbox.id
  region                   = var.region
  ip_cidr_range            = "10.10.1.0/24"
  private_ip_google_access = true
}

# *.googleapis.com / *.run.app を private.googleapis.com (199.36.153.8/30) に向ける
resource "google_dns_managed_zone" "googleapis" {
  name       = "agent-sandbox-googleapis"
  dns_name   = "googleapis.com."
  visibility = "private"
  private_visibility_config {
    networks {
      network_url = google_compute_network.sandbox.id
    }
  }
}

resource "google_dns_record_set" "googleapis_a" {
  managed_zone = google_dns_managed_zone.googleapis.name
  name         = "private.googleapis.com."
  type         = "A"
  ttl          = 300
  rrdatas      = ["199.36.153.8", "199.36.153.9", "199.36.153.10", "199.36.153.11"]
}

resource "google_dns_record_set" "googleapis_cname" {
  managed_zone = google_dns_managed_zone.googleapis.name
  name         = "*.googleapis.com."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["private.googleapis.com."]
}

# Gateway → Runner (internal ingress) も Private Google Access 経由で到達させる
resource "google_dns_managed_zone" "run_app" {
  name       = "agent-sandbox-run-app"
  dns_name   = "run.app."
  visibility = "private"
  private_visibility_config {
    networks {
      network_url = google_compute_network.sandbox.id
    }
  }
}

resource "google_dns_record_set" "run_app_a" {
  managed_zone = google_dns_managed_zone.run_app.name
  name         = "run.app."
  type         = "A"
  ttl          = 300
  rrdatas      = ["199.36.153.8", "199.36.153.9", "199.36.153.10", "199.36.153.11"]
}

resource "google_dns_record_set" "run_app_cname" {
  managed_zone = google_dns_managed_zone.run_app.name
  name         = "*.run.app."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["run.app."]
}

# --- firewall (runner) ---

resource "google_compute_firewall" "runner_allow_google_apis" {
  name               = "agent-sandbox-runner-allow-google-apis"
  network            = google_compute_network.sandbox.id
  direction          = "EGRESS"
  priority           = 1000
  target_tags        = ["agent-sandbox-runner"]
  destination_ranges = ["199.36.153.8/30"]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "runner_allow_internet" {
  count              = var.runner_internet_access ? 1 : 0
  name               = "agent-sandbox-runner-allow-internet"
  network            = google_compute_network.sandbox.id
  direction          = "EGRESS"
  priority           = 1100
  target_tags        = ["agent-sandbox-runner"]
  destination_ranges = ["0.0.0.0/0"]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# VPC 内の他リソース（Gateway 含む）や内部レンジへの横移動も禁止
resource "google_compute_firewall" "runner_deny_all" {
  name               = "agent-sandbox-runner-deny-all-egress"
  network            = google_compute_network.sandbox.id
  direction          = "EGRESS"
  priority           = 65000
  target_tags        = ["agent-sandbox-runner"]
  destination_ranges = ["0.0.0.0/0"]
  deny {
    protocol = "all"
  }
}

# --- NAT (internet access mode only) ---

resource "google_compute_router" "router" {
  count   = var.runner_internet_access ? 1 : 0
  name    = "agent-sandbox-router"
  network = google_compute_network.sandbox.id
  region  = var.region
}

resource "google_compute_router_nat" "nat" {
  count                              = var.runner_internet_access ? 1 : 0
  name                               = "agent-sandbox-nat"
  router                             = google_compute_router.router[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.sandbox.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}
