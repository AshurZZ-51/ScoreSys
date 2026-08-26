\set ON_ERROR_STOP on

\if :{?migrator_pw}
\else
  \echo 'migrator_pw psql variable is required'
  \quit 2
\endif
\if :{?app_pw}
\else
  \echo 'app_pw psql variable is required'
  \quit 2
\endif
\if :{?database_name}
\else
  \set database_name scoringsys
\endif

SELECT format(
  'CREATE ROLE scoringsys_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',
  :'migrator_pw'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scoringsys_migrator')
\gexec

SELECT format(
  'CREATE ROLE scoringsys_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_pw'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scoringsys_app')
\gexec

ALTER ROLE scoringsys_migrator PASSWORD :'migrator_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE scoringsys_app PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE scoringsys_app SET statement_timeout = '15s';
ALTER ROLE scoringsys_app SET idle_in_transaction_session_timeout = '30s';

SELECT format(
  'CREATE DATABASE %I OWNER scoringsys_migrator ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0',
  :'database_name', 'UTF8', 'C', 'C'
)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database_name')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO scoringsys_migrator, scoringsys_app',
  :'database_name'
)
\gexec

\connect :database_name
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO scoringsys_migrator;
GRANT USAGE ON SCHEMA public TO scoringsys_app;
