-- Runs once, when the Postgres data volume is first created (docker-entrypoint-initdb.d; story P-06).
-- The API's own role: it can log in and read and write rows, but owns no table, is no superuser and has no
-- BYPASSRLS, so the row-level security policies of the migrations bind it (ADR 0014). The migrate job uses the
-- owner role (POSTGRES_USER). The password is a fixed development value from Compose, never a production secret.
\getenv app_password VULNMART_APP_DB_PASSWORD
CREATE ROLE vulnmart_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE vulnmart TO vulnmart_app;
