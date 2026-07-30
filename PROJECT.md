# Inboxly

## Product Vision

Inboxly is an AI-powered Gmail triage dashboard that helps users quickly understand and prioritize their inbox.

Instead of manually scanning every email, users connect their Gmail account through Google OAuth. Inboxly continuously synchronizes new emails, classifies them using AI, extracts actionable information, and presents everything through a fast, modern dashboard.

The application should feel like a polished production SaaS rather than a demo project.

The finished repository should resemble software developed over several weeks by an experienced full-stack engineer and should confidently strengthen a professional software engineering portfolio.

---

# Goals

Build a production-ready application demonstrating:

- modern frontend architecture
- scalable backend architecture
- OAuth integration
- Gmail API integration
- AI integration
- provider abstraction
- typed AI pipelines
- background synchronization
- production-grade error handling
- testing
- documentation
- realistic Git history

---

# Technology Stack

## Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query

## Backend

- Next.js Route Handlers
- tRPC

## Database

- PostgreSQL

ORM

- Prisma

Authentication

- Google OAuth 2.0

Email

- Gmail API

Validation

- Zod

AI

Provider-agnostic architecture

Default implementation:

- Anthropic API

Deployment

- Vercel

---

# Core User Journey

A user should be able to:

1. Sign in using Google.
2. Connect Gmail.
3. Synchronize their inbox.
4. Watch synchronization progress.
5. View AI-classified emails.
6. Search and filter emails.
7. Read AI summaries.
8. See action items and deadlines.
9. Generate reply suggestions.
10. Return later and continue from the previous synchronization state.

---

# Functional Requirements

## Authentication

Implement:

- Google OAuth
- secure session management
- refresh token handling
- reconnect flow
- logout
- CSRF protection

---

## Gmail Synchronization

Synchronize Gmail using incremental synchronization.

Support:

- Gmail History API
- pagination
- retries
- exponential backoff
- API quota handling
- duplicate detection
- deleted emails
- updated emails
- resumable synchronization
- persistent sync checkpoints

Synchronization should always be idempotent.

---

## AI Processing

Every synchronized email should be processed by AI.

Business logic must never communicate directly with any AI SDK.

Implement a provider abstraction.

Default provider:

Anthropic

Future providers should require minimal implementation effort.

---

## Typed AI Pipeline

Treat AI as an untrusted dependency.

Every AI response must follow this pipeline:

Raw Gmail Email

↓

AI Provider

↓

Structured JSON

↓

Zod Validation

↓

Typed Domain Model

↓

Database

↓

API

↓

React UI

Never expose raw AI responses to the application.

Retry invalid responses.

Never persist invalid data.

Infer TypeScript types directly from Zod schemas whenever practical.

---

## Structured AI Output

Every processed email should include:

- category
- urgency
- sentiment
- requiresResponse
- confidence
- summary
- suggestedReply
- actionItems
- deadlines
- meetingInformation
- extractedEntities

---

## Email Processing Lifecycle

Each synchronized email should move through a lifecycle.

Possible states:

- Pending
- Processing
- Completed
- Failed
- Needs Retry

Interrupted processing should resume safely.

Processing should never duplicate work.

---

## Dashboard

Implement a responsive SaaS dashboard.

Dashboard widgets should include:

- Total Emails
- AI Processed Emails
- Processing Queue
- Failed Processing
- Last Synchronization
- Gmail Sync Status
- Average Processing Time

Views should include:

- Inbox
- Needs Reply
- Important
- Meetings
- Finance
- Personal
- Promotions

Provide:

- search
- filtering
- sorting
- pagination

---

## AI Features

Generate:

- concise summaries
- suggested replies
- extracted action items
- deadlines
- meeting information
- important entities

---

## Search

Support searching by:

- sender
- recipient
- subject
- AI summary
- category
- urgency
- entities
- date

---

# Non-Functional Requirements

## Performance

Optimize:

- Gmail API requests
- batching
- database indexing
- pagination
- lazy loading
- caching where appropriate

---

## Security

Implement:

- OAuth best practices
- encrypted refresh tokens
- secure cookies
- CSRF protection
- rate limiting
- input validation
- secure secret management

---

## Accessibility

Support:

- keyboard navigation
- semantic HTML
- ARIA attributes
- sufficient color contrast

---

## Error Handling

Errors should be:

- typed
- recoverable where appropriate
- logged
- presented with user-friendly messages

Never expose internal implementation details.

---

## Observability

Implement:

- structured logging
- request logging
- background processing logs
- synchronization metrics
- health endpoint
- graceful shutdown

---

## Developer Experience

Use:

- TypeScript
- ESLint
- Prettier
- Husky
- environment validation
- Git hooks

---

# Testing

Implement:

- unit tests
- integration tests
- Gmail sync tests
- authentication tests
- AI validation tests
- API tests
- database tests

---

# Documentation

Maintain:

- README
- Architecture
- API documentation
- Database documentation
- Deployment guide
- Architecture Decision Records

Documentation should evolve alongside implementation.

---

# Stretch Goals

If all core requirements have been completed, consider implementing:

- Dark mode
- Keyboard shortcuts
- Bulk actions
- Saved filters
- Export analytics
- AI confidence explanations

These are optional and should never compromise the quality of the core application.

---

# Definition of Done

The project is complete only when:

- every functional requirement has been implemented
- tests are passing
- documentation is complete
- deployment is production-ready
- Git history is clean and realistic
- architecture is maintainable
- AI responses are fully validated
- the repository resembles a real production SaaS
- the project would confidently strengthen a senior software engineering portfolio