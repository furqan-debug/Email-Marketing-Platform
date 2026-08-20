# Project Rules — READ BEFORE EVERY TASK

## Scope discipline
- Only touch the files explicitly named in the current task. If a task seems to require
  touching a file not named, STOP and ask instead of expanding scope.
- Never create new services, new database tables, or new npm packages unless the task
  explicitly asks for them.
- Never touch AWS, SES, Stripe, or any external API config unless explicitly instructed.
  Local development uses docker-compose Postgres + Redis + a fake SES adapter until
  told otherwise.
- If a task is ambiguous, do not guess the ambiguous part. State the ambiguity and
  propose one option, then wait.

## Definition of done for every task
- Code compiles / type-checks with zero errors.
- The specific test named in the task passes.
- No unrelated files changed (check git diff before finishing).
- No new dependencies added unless explicitly requested.

## Architecture invariants (do not violate even if it seems more convenient)
- Domain chain is: Workspace → Audience → Contacts → Campaign → Messages → Events.
  Campaigns do not own contact data. Contacts belong to Audiences, not Campaigns.
- All email sending goes through the queue (BullMQ). No direct SES/fake-SES calls
  from API route handlers.
- All external email provider calls go through a single adapter interface
  (`EmailProvider`), so the fake adapter and real SES adapter are interchangeable.

## Current build stage
Phase 9 complete — Welcome Series workflow engine built with mid-workflow
suppression enforcement. Verified via named unit test
(workflows.service.spec.ts) proving unsubscribe after Step 1 halts Step 2/3.
Delay implemented via BullMQ delayed jobs (testable with short delays, not
hardcoded to real wall-clock time).