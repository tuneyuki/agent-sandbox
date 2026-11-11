output "gateway_url" {
  value = google_cloud_run_v2_service.gateway.uri
}

output "runner_url" {
  value = google_cloud_run_v2_service.runner.uri
}

output "state_bucket" {
  value = google_storage_bucket.state.name
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}"
}
