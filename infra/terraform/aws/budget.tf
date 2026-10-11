# Budgets e-mail the owner. They lag by up to a day and only send e-mail: they stop nothing. Whether Budgets counts
# the Free Plan credit is unverified (runbook Part D). The real protection is the weekly credit check in the Billing
# console and stopping the labs host (vm_i_running = false).
#
# 1. Zero spend: cost after credits. Any real charge (above USD 0.01) means the credit is used up or something is billed.
resource "aws_budgets_budget" "zero_spend" {
  name         = "vulnmart-zero-spend"
  budget_type  = "COST"
  limit_amount = "0.01"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
}

# 2. Monthly use before credits, alerts at 50, 80 and 100 percent of monthly_budget_usd.
resource "aws_budgets_budget" "monthly_use" {
  name         = "vulnmart-monthly-use"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
  }

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}