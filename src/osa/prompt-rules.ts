// Prompt fragments shared by every OSA stage. After the single Lock confirmation nobody is available to answer anything, so every
// model prompt says so (OSA_DIRECTIVE.md: no questions mid-run).

/** One line, prepended to every post-lock prompt. */
export const NO_QUESTIONS = "Nobody is available to answer questions: do not ask any. If something is unclear, take the most reasonable reading and say what you assumed.";
