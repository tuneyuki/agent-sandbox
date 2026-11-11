# Runner からのパッケージ取得用ミラー。
# Artifact Registry のリモートリポジトリが npmjs / PyPI をプロキシ・キャッシュする。
# Runner はインターネットに出られなくても、Private Google Access 経由で *.pkg.dev には届く。

resource "google_artifact_registry_repository" "npm_remote" {
  count         = var.package_mirror ? 1 : 0
  repository_id = "npm-remote"
  location      = var.region
  format        = "NPM"
  mode          = "REMOTE_REPOSITORY"
  description   = "npmjs proxy for agent sandbox"
  remote_repository_config {
    npm_repository {
      public_repository = "NPMJS"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "pypi_remote" {
  count         = var.package_mirror ? 1 : 0
  repository_id = "pypi-remote"
  location      = var.region
  format        = "PYTHON"
  mode          = "REMOTE_REPOSITORY"
  description   = "PyPI proxy for agent sandbox"
  remote_repository_config {
    python_repository {
      public_repository = "PYPI"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "runner_npm" {
  count      = var.package_mirror ? 1 : 0
  location   = var.region
  repository = google_artifact_registry_repository.npm_remote[0].name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_artifact_registry_repository_iam_member" "runner_pypi" {
  count      = var.package_mirror ? 1 : 0
  location   = var.region
  repository = google_artifact_registry_repository.pypi_remote[0].name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runner.email}"
}

# *.pkg.dev も private.googleapis.com (199.36.153.8/30) に向ける
resource "google_dns_managed_zone" "pkg_dev" {
  name       = "agent-sandbox-pkg-dev"
  dns_name   = "pkg.dev."
  visibility = "private"
  private_visibility_config {
    networks {
      network_url = google_compute_network.sandbox.id
    }
  }
}

resource "google_dns_record_set" "pkg_dev_a" {
  managed_zone = google_dns_managed_zone.pkg_dev.name
  name         = "pkg.dev."
  type         = "A"
  ttl          = 300
  rrdatas      = ["199.36.153.8", "199.36.153.9", "199.36.153.10", "199.36.153.11"]
}

resource "google_dns_record_set" "pkg_dev_cname" {
  managed_zone = google_dns_managed_zone.pkg_dev.name
  name         = "*.pkg.dev."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["pkg.dev."]
}

locals {
  npm_mirror_url  = var.package_mirror ? "https://${var.region}-npm.pkg.dev/${var.project_id}/npm-remote/" : ""
  pypi_mirror_url = var.package_mirror ? "https://${var.region}-python.pkg.dev/${var.project_id}/pypi-remote/simple/" : ""
}
