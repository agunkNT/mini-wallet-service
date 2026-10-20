DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wallet') THEN
    CREATE USER wallet WITH SUPERUSER PASSWORD 'wallet';
  END IF;
END $$;

SELECT 'CREATE DATABASE wallet OWNER wallet'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'wallet')\gexec

SELECT 'CREATE DATABASE wallet_test OWNER wallet'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'wallet_test')\gexec
