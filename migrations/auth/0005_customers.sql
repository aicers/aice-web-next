CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  database_name TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE account_customer (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  PRIMARY KEY (account_id, customer_id)
);
