# In Character: demo script and submission draft

Drafts for M6 (due Wed 4 Nov 2026, 7 PM Arizona). The live link is filled in.

## Demo video (2–3 minutes)

Record on a phone screen (or the laptop at 390 px wide), voice on, after the student voices are recorded.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 | Home: "Experience it to learn it." | "The best way to learn something is to teach it. In Character puts you in the role." |
| 0:08 | Spanish → Food & Eating Out → At the Restaurant; the briefing notes | "Every lesson comes from FlashFeed's knowledge packs. You study the notes, then you teach." |
| 0:20 | Teaching by voice (sped up), the level bar at the top, one hold-to-peek | "You teach out loud. Muse Voice Transcribe hears English and Spanish together. Peeking at the notes costs points." |
| 1:05 | The classroom: Maya, Leo and Sam ask; name tags show who's asking | "Four AI students ask real questions from a checked bank. Sam holds a misconception until you fix it." |
| 1:50 | The debrief: the score counts up, then "How your score was calculated" with your quotes | "Muse Spark grades, and every verdict quotes your own words. Code checks each quote before it counts." |
| 2:15 | The tools card, then the link | "Built with Muse Code. Graded by Muse Spark. Heard by Muse Voice Transcribe. Drawn by Muse Image. Try it at https://incharacter.recurxive.workers.dev." |

For the live finals: Type mode needs no microphone, and keep the recorded video ready.

## Submission text (draft)

**In Character: role-play what you learn.**

A quiz shows whether you remember an idea, not whether you can use it. In Character puts learners in a role where
they have to recall and apply what they've just learned. The first simulation is a classroom: you teach a lesson from
FlashFeed's knowledge packs to four AI students, answer their questions, and get a score backed by your own words.

- **Grounded:** lessons are read at run time from FlashFeed's public pack catalog. Students ask only questions from a
  bank that a writer model drafted, code checked against the notes, and a second model reviewed.
- **Honest grading:** Muse Spark grades the class and each answer, and must quote the learner. Code checks every quote
  against the transcript; a verdict without a real quote doesn't count. On the spec's labeled fixtures the grader agrees
  with the labels on 100% of notes and 90% of answer points, and a prompt-injection line changes nothing.
- **Voice:** teach and answer out loud. Muse Voice Transcribe handles English mixed with Spanish, biased toward the
  lesson's terms.
- **Built with Meta's tools:** Muse Code built the app from a written spec; Muse Spark chooses questions and grades;
  Muse Wonder checks the question banks; Muse Voice Transcribe hears the learner; Muse Image drew the classroom and
  cast. (SAM 3.1 was tried for locating the students; it found one person in the picture, so name tags replaced the
  outlines.)

Next: more roles on the same harness, such as coaching a client with Atomic Habits or getting around Mexico City in
Spanish, and immersive VR on Meta Quest.

- Try it: https://incharacter.recurxive.workers.dev
- Code (Apache-2.0): https://github.com/garygeo-19/InCharacter
- FlashFeed: https://flashfeedlearningapp.com
