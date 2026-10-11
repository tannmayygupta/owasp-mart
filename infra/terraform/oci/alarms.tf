# Idle alarm (runbook Part D). Oracle reclaims a VM that is idle for 7 days; the keep-alive service should prevent
# it, and this alarm tells the owner by e-mail if memory stays low anyway. The query text is unverified until
# the live run (runbook Part D): check the alarm in the console after the first day.
resource "oci_ons_notification_topic" "alerts" {
  compartment_id = var.compartment_ocid
  name           = "vulnmart-idle-alerts"
}

resource "oci_ons_subscription" "owner" {
  compartment_id = var.compartment_ocid
  topic_id       = oci_ons_notification_topic.alerts.id
  protocol       = "EMAIL"
  endpoint       = var.alarm_email
}

resource "oci_monitoring_alarm" "idle_memory" {
  for_each                     = toset(local.vm_names)
  compartment_id               = var.compartment_ocid
  metric_compartment_id        = var.compartment_ocid
  display_name                 = "${each.key}-memory-low"
  namespace                    = "oci_computeagent"
  query                        = "MemoryUtilization[1h]{resourceId = \"${oci_core_instance.vm[each.key].id}\"}.mean() < 20"
  severity                     = "WARNING"
  destinations                 = [oci_ons_notification_topic.alerts.id]
  is_enabled                   = true
  pending_duration             = "PT1H"
  repeat_notification_duration = "PT24H"
  body                         = "${each.key}: memory use is under 20 percent for an hour. The keep-alive service may be stopped; Oracle reclaims a VM idle for 7 days."
}

# A missing metric means the monitoring plugin stopped or the VM is down; the low-memory alarm cannot fire then.
# Same owner topic. Unverified until runbook Part D (the `absent()` query is checked live).
resource "oci_monitoring_alarm" "metric_missing" {
  for_each                     = toset(local.vm_names)
  compartment_id               = var.compartment_ocid
  metric_compartment_id        = var.compartment_ocid
  display_name                 = "${each.key}-metric-missing"
  namespace                    = "oci_computeagent"
  query                        = "MemoryUtilization[5m]{resourceId = \"${oci_core_instance.vm[each.key].id}\"}.absent()"
  severity                     = "CRITICAL"
  destinations                 = [oci_ons_notification_topic.alerts.id]
  is_enabled                   = true
  pending_duration             = "PT10M"
  repeat_notification_duration = "PT24H"
  body                         = "${each.key}: no memory metric for 10 minutes. The VM may be down or the monitoring plugin stopped."
}