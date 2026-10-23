// Implements PHASE_1_SPEC.md §3.2
//
// The abstract effort-tier axis roles are recorded against. Deliberately contains nothing else:
// no mapping from tier to any provider's concrete effort value. That mapping is mechanism and
// belongs to `src/adapters/**` in Phase 2 -- a tier->effort table appearing in this file is a
// boundary rule B7 violation (PRD §6.1--6.2).

import { z } from "zod";

/** The three abstract model tiers roles may be assigned (PRD §6.2). */
export const MODEL_TIERS = ["research-grade", "verification-grade", "high-volume-low-effort"] as const;

/** A member of {@link MODEL_TIERS}. */
export type ModelTier = (typeof MODEL_TIERS)[number];

/** zod schema for {@link ModelTier}. */
export const ModelTierSchema = z.enum(MODEL_TIERS);
