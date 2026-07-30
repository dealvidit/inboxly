-- Runs once, when the Postgres volume is first initialised.
-- Integration tests point at this database so they can truncate freely without
-- touching development data.
CREATE DATABASE inboxly_test OWNER inboxly;
