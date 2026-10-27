# In Character: rules for coding agents

This folder builds **In Character**, a mobile-first web app. A learner teaches a 3-minute class from a lesson's notes,
then answers three AI students' questions, and gets a score backed by their own words. `REQUIREMENTS.md` is the spec:
read it before changing anything.

- Work through the milestones in REQUIREMENTS.md §12 in order. A milestone is done when its acceptance checks pass.
- Text first: every phase must work in Type mode before you add audio.
- Don't guess Meta Model API request shapes. Open the docs page linked in REQUIREMENTS.md §9 or Appendix D.
- Keys (`MODEL_API_KEY`, `ELEVENLABS_API_KEY`) never go in client code, the repo, or logs.
- Students ask only questions from approved banks (§7). Never write student questions at run time.
- Scores come from code, using only verdicts whose quotes code has checked against the transcript (§8.5).
- Read FlashFeed packs from the public catalog at run time. Don't copy pack files into the repo.
- Design at 390 × 844 first, then check 360 × 800 and 1280 × 800.
- Put shared logic in `src/shared/`, with unit tests.
- Don't commit, push or deploy unless asked.
- When the spec is silent, choose the simplest thing that works and note it under "Decisions" in README.md.
