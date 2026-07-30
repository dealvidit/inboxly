-- Maintain emails."searchVector" in the database rather than in application code.
--
-- The column and its GIN index are declared in schema.prisma (as Unsupported("tsvector"),
-- which is as much as Prisma can express). Populating it is done here, by triggers, for
-- one reason: correctness must not depend on which code path wrote the row. Sync upserts,
-- label updates, analysis writes, and manual fixes in psql all converge on the same
-- definition.
--
-- Weights follow how people actually search their mail:
--   A  subject     — the strongest signal
--   B  sender      — display name and address
--   C  AI summary  — so search covers what the model understood, not only what the
--                    message literally said
--   D  snippet     — weakest, but catches body wording
--
-- Triggers are invisible to Prisma's drift detection, so this migration does not fight
-- future `prisma migrate dev` runs.

-- ─── The single definition of an email's search vector ───────────────────────
CREATE OR REPLACE FUNCTION inboxly_email_search_vector(
  p_subject    TEXT,
  p_from_name  TEXT,
  p_from_email TEXT,
  p_summary    TEXT,
  p_snippet    TEXT
) RETURNS tsvector AS $$
  SELECT setweight(to_tsvector('english', coalesce(p_subject, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p_from_name, '')), 'B')
      -- The address is indexed twice, deliberately. Postgres's parser treats
      -- "billing@acmecorp.test" as a single `email` lexeme, so a search for the domain
      -- or the local part alone would miss it. Replacing @ and . with spaces yields
      -- "billing acmecorp test" as separate lexemes, which is how people actually
      -- search. Keeping the original too means the full address still matches exactly.
      || setweight(to_tsvector('english', coalesce(p_from_email, '')), 'B')
      || setweight(
           to_tsvector('english', translate(coalesce(p_from_email, ''), '@._-+', '     ')),
           'B'
         )
      || setweight(to_tsvector('english', coalesce(p_summary, '')), 'C')
      || setweight(to_tsvector('english', coalesce(p_snippet, '')), 'D');
$$ LANGUAGE sql IMMUTABLE;

-- ─── Keep it current when the message itself changes ─────────────────────────
CREATE OR REPLACE FUNCTION inboxly_emails_search_vector_trigger() RETURNS trigger AS $$
DECLARE
  v_summary TEXT;
BEGIN
  -- A freshly inserted email cannot have an analysis yet, so skip the lookup.
  IF TG_OP = 'UPDATE' THEN
    SELECT a."summary" INTO v_summary
    FROM "email_analyses" a
    WHERE a."emailId" = NEW."id";
  END IF;

  NEW."searchVector" := inboxly_email_search_vector(
    NEW."subject", NEW."fromName", NEW."fromEmail", v_summary, NEW."snippet"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER emails_search_vector
  BEFORE INSERT OR UPDATE OF "subject", "fromName", "fromEmail", "snippet"
  ON "emails"
  FOR EACH ROW
  EXECUTE FUNCTION inboxly_emails_search_vector_trigger();

-- ─── Fold the AI summary in when an analysis lands ───────────────────────────
-- This updates only "searchVector", which is not in the trigger column list above, so
-- the two triggers cannot recurse into each other.
CREATE OR REPLACE FUNCTION inboxly_analysis_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  UPDATE "emails" e
  SET "searchVector" = inboxly_email_search_vector(
    e."subject", e."fromName", e."fromEmail", NEW."summary", e."snippet"
  )
  WHERE e."id" = NEW."emailId";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_analyses_search_vector
  AFTER INSERT OR UPDATE OF "summary"
  ON "email_analyses"
  FOR EACH ROW
  EXECUTE FUNCTION inboxly_analysis_search_vector_trigger();

-- Populate any rows that predate the triggers. No-op on a fresh database.
UPDATE "emails" e
SET "searchVector" = inboxly_email_search_vector(
  e."subject", e."fromName", e."fromEmail",
  (SELECT a."summary" FROM "email_analyses" a WHERE a."emailId" = e."id"),
  e."snippet"
);
