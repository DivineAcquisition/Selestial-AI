# Real job-board notifications

Redacted `.eml` files of real Indeed and ZipRecruiter notifications go here. Every file is read by
`convex/recruiterIntake.test.ts` ("Recruiter: real job-board notifications") and what Recruiter makes of it
is pinned in a snapshot.

How to capture one, what to redact and how to review the snapshot: `docs/recruiter/07-real-samples.md`.

This directory is empty on purpose until someone has real samples. Do not put invented messages here:
the invented ones live in `tests/recruiterHarness.ts`.
