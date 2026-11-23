# Smoke tests

GitHub Actions runs the API smoke tests on pushes to `automation/backtest-metrics-release`,
manually, and daily.

Repository configuration:
- Secret `PREDICTOR_ACCESS_TOKEN`: same bearer token configured on Render.
- Variable `TEST_MATCH_ID` (optional): ID of a fixture already synchronized
  in Supabase. When present, the workflow also checks the prediction endpoint.

The test workflow is read-only: it sends GET requests and does not modify
application or database records.
