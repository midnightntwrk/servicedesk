# Thanks for the Report — 
## Here's What We Need Before We Can Act on It:

We appreciate you taking the time to flag potential issues. However, we can't triage bug reports that are essentially an unverified list of things an AI *thinks* might be wrong. LLMs are confident, not correct — and a model scanning a codebase will happily hallucinate bugs that don't exist, misread intent, or flag behavior that's working exactly as designed.

Before submitting a bug report, we need you to clear the following bar:

## 1. Verify You're on the Right Branch

Confirm you are working against the correct and **up-to-date branch**. Include the branch name and the commit SHA you tested against. Stale branches are not bug reports.

## 2. Prove It With a Test

Don't just tell us something *looks* wrong — prove it *is* wrong. Have Claude Code (or whatever tool you're using) write a **concrete**, runnable test case that demonstrates the failure. ** If you can't reproduce it in a test, it's not ready to report.**

## 3. Submit a Complete Report

Every bug report must include:

- **Branch & commit SHA** you tested against
- **File paths and line references** to the code in question
- **A runnable test case** (included in full, not summarized)
- **Expected behavior** — what *should* happen and why you believe that
- **Actual behavior** — what *does* happen when you run the test
- **Relevant logs / stack traces / error output**

---

## What We Will Not Accept

- A bulk list of "potential issues" with no reproduction steps
- AI-generated summaries with no verification
- Reports against code that doesn't exist on the current branch
- "I think this might be a bug" without a failing test

We'd rather receive one well-verified bug than twenty unverified guesses. Quality over quantity — every time.
