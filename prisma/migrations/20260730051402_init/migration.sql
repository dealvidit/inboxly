-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_RECONNECT', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "SyncPhase" AS ENUM ('BACKFILL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('CRON', 'USER', 'INITIAL_CONNECT');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'NEEDS_RETRY');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('WORK', 'PERSONAL', 'FINANCE', 'MEETING', 'PROMOTION', 'NEWSLETTER', 'NOTIFICATION', 'SUPPORT', 'TRAVEL', 'SPAM', 'OTHER');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCEEDED', 'INVALID_OUTPUT', 'UNPARSEABLE_OUTPUT', 'PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "googleSubject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accessTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenCiphertext" TEXT,
    "scopes" TEXT[],
    "connectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "connectionError" TEXT,
    "gmailAddress" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_checkpoints" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "phase" "SyncPhase" NOT NULL DEFAULT 'BACKFILL',
    "historyId" TEXT,
    "backfillPageToken" TEXT,
    "backfillMessagesSynced" INTEGER NOT NULL DEFAULT 0,
    "backfillCompletedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "phase" "SyncPhase" NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "messagesFetched" INTEGER NOT NULL DEFAULT 0,
    "messagesCreated" INTEGER NOT NULL DEFAULT 0,
    "messagesUpdated" INTEGER NOT NULL DEFAULT 0,
    "messagesDeleted" INTEGER NOT NULL DEFAULT 0,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "gmailThreadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "bodyText" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT NOT NULL,
    "toEmails" TEXT[],
    "ccEmails" TEXT[],
    "replyTo" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "labels" TEXT[],
    "isUnread" BOOLEAN NOT NULL DEFAULT true,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "isImportant" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "sizeEstimate" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "processingLeaseUntil" TIMESTAMP(3),
    "processingError" TEXT,
    "processedAt" TIMESTAMP(3),
    "searchVector" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_analyses" (
    "id" UUID NOT NULL,
    "emailId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "EmailCategory" NOT NULL,
    "urgency" "Urgency" NOT NULL,
    "sentiment" "Sentiment" NOT NULL,
    "requiresResponse" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "summary" TEXT NOT NULL,
    "suggestedReply" TEXT,
    "actionItems" JSONB NOT NULL,
    "deadlines" JSONB NOT NULL,
    "meetingInformation" JSONB,
    "extractedEntities" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_attempts" (
    "id" UUID NOT NULL,
    "emailId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "validationErrors" JSONB,
    "rawResponse" TEXT,
    "errorMessage" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_googleSubject_key" ON "users"("googleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_userId_key" ON "google_accounts"("userId");

-- CreateIndex
CREATE INDEX "google_accounts_connectionStatus_idx" ON "google_accounts"("connectionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "sync_checkpoints_userId_key" ON "sync_checkpoints"("userId");

-- CreateIndex
CREATE INDEX "sync_runs_userId_startedAt_idx" ON "sync_runs"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "emails_userId_receivedAt_idx" ON "emails"("userId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "emails_userId_processingStatus_idx" ON "emails"("userId", "processingStatus");

-- CreateIndex
CREATE INDEX "emails_userId_gmailThreadId_idx" ON "emails"("userId", "gmailThreadId");

-- CreateIndex
CREATE INDEX "emails_searchVector_idx" ON "emails" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "emails_userId_gmailMessageId_key" ON "emails"("userId", "gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_analyses_emailId_key" ON "email_analyses"("emailId");

-- CreateIndex
CREATE INDEX "email_analyses_userId_category_idx" ON "email_analyses"("userId", "category");

-- CreateIndex
CREATE INDEX "email_analyses_userId_urgency_idx" ON "email_analyses"("userId", "urgency");

-- CreateIndex
CREATE INDEX "email_analyses_userId_requiresResponse_idx" ON "email_analyses"("userId", "requiresResponse");

-- CreateIndex
CREATE INDEX "analysis_attempts_emailId_createdAt_idx" ON "analysis_attempts"("emailId", "createdAt");

-- CreateIndex
CREATE INDEX "analysis_attempts_userId_outcome_createdAt_idx" ON "analysis_attempts"("userId", "outcome", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_analyses" ADD CONSTRAINT "email_analyses_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_analyses" ADD CONSTRAINT "email_analyses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_attempts" ADD CONSTRAINT "analysis_attempts_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_attempts" ADD CONSTRAINT "analysis_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
