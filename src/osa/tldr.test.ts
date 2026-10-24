import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApprovalTldr } from "./tldr.ts";
import type { TldrInput } from "./tldr.ts";

test("buildApprovalTldr: populated input yields readable lines", () => {
  const input: TldrInput = {
    prd: {
      tldr: ["Build a chat application"],
      problem: "Users need to communicate",
      users: "Teams of 5-50 people",
      inScope: ["Real-time messaging"],
      outOfScope: ["Video calls"],
      acceptanceCriteria: ["Messages appear within 1 second"],
      constraints: [],
      researchPlan: {
        topic: "Real-time messaging systems",
        timeRange: "Last 2 years",
        items: [],
        docsTargets: [],
        academicQueries: [],
        priorArtQueries: [],
      },
      assumptions: [
        { text: "WebSockets are available", risk: "safe" },
        { text: "Eventual consistency is acceptable", risk: "risky" },
        { text: "User limit is 1000", risk: "defaulted" },
      ],
      scope: "narrow",
      recommendedQuestions: [],
    },
    specAssumptions: ["[risky] Use PostgreSQL for persistence", "Store messages in-memory initially"],
    totalPhases: 3,
    risky: [{ text: "Eventual consistency is acceptable", risk: "risky" }],
    defaulted: [{ text: "User limit is 1000", risk: "defaulted" }],
    researchSkipped: false,
    flaggedClaims: ["WebSocket scalability at 10k concurrent users"],
    reviewText: "Original plan author and independent reviewer (different models)",
  };

  const result = buildApprovalTldr(input);

  assert(!("stop" in result), "Should return lines, not stop");
  const lines = result.lines as readonly string[];

  // Verify content
  const text = lines.join("\n");
  assert(text.includes("Build a chat application"), "Should mention the goal");
  assert(text.includes("3 build phase"), "Should mention total phases");
  assert(text.includes("Risky assumption"), "Should mention risky assumptions");
  assert(text.includes("Eventual consistency is acceptable"), "Should list the risky assumption");
  assert(text.includes("Assumed defaults"), "Should mention defaulted assumptions");
  assert(text.includes("User limit is 1000"), "Should list the defaulted assumption");
  assert(text.includes("WebSocket scalability"), "Should mention flagged claims");
  assert(text.includes("independent review"), "Should mention review independence");
  assert(text.includes("decision"), "Should mention decisions");
});

test("buildApprovalTldr: deterministic (same input → identical output)", () => {
  const input: TldrInput = {
    prd: {
      tldr: ["Build X"],
      problem: "Problem",
      users: "Users",
      inScope: ["In scope"],
      outOfScope: [],
      acceptanceCriteria: ["Criterion 1"],
      constraints: [],
      researchPlan: {
        topic: "Topic",
        timeRange: "Time range",
        items: [],
        docsTargets: [],
        academicQueries: [],
        priorArtQueries: [],
      },
      assumptions: [{ text: "Assumption", risk: "safe" }],
      scope: "narrow",
      recommendedQuestions: [],
    },
    specAssumptions: [],
    totalPhases: 1,
    risky: [],
    defaulted: [],
    researchSkipped: false,
    flaggedClaims: [],
    reviewText: "Test review",
  };

  const result1 = buildApprovalTldr(input);
  const result2 = buildApprovalTldr(input);

  assert(!("stop" in result1) && !("stop" in result2), "Both should return lines");
  assert.deepEqual(result1.lines, result2.lines, "Same input should produce identical output");
});

test("buildApprovalTldr: empty goal returns stop", () => {
  const input: TldrInput = {
    prd: {
      tldr: [],
      problem: "Problem",
      users: "Users",
      inScope: ["In scope"],
      outOfScope: [],
      acceptanceCriteria: ["Criterion"],
      constraints: [],
      researchPlan: {
        topic: "Topic",
        timeRange: "Time",
        items: [],
        docsTargets: [],
        academicQueries: [],
        priorArtQueries: [],
      },
      assumptions: [],
      scope: "narrow",
      recommendedQuestions: [],
    },
    specAssumptions: [],
    totalPhases: 1,
    risky: [],
    defaulted: [],
    researchSkipped: false,
    flaggedClaims: [],
    reviewText: "Review",
  };

  const result = buildApprovalTldr(input);
  assert("stop" in result, "Should return stop when goal is empty");
  assert(result.stop.includes("goal"), "Stop message should mention goal");
});

test("buildApprovalTldr: missing scope returns stop", () => {
  const input: any = {
    prd: {
      tldr: ["Build X"],
      problem: "Problem",
      users: "Users",
      inScope: ["In scope"],
      outOfScope: [],
      acceptanceCriteria: ["Criterion"],
      constraints: [],
      researchPlan: {
        topic: "Topic",
        timeRange: "Time",
        items: [],
        docsTargets: [],
        academicQueries: [],
        priorArtQueries: [],
      },
      assumptions: [],
      scope: undefined, // invalid
      recommendedQuestions: [],
    },
    specAssumptions: [],
    totalPhases: 1,
    risky: [],
    defaulted: [],
    researchSkipped: false,
    flaggedClaims: [],
    reviewText: "Review",
  };

  const result = buildApprovalTldr(input);
  assert("stop" in result, "Should return stop when scope is invalid");
  assert(result.stop.includes("scope"), "Stop message should mention scope");
});

test("buildApprovalTldr: spec decisions with no risk tag noted", () => {
  const input: TldrInput = {
    prd: {
      tldr: ["Build X"],
      problem: "Problem",
      users: "Users",
      inScope: ["In scope"],
      outOfScope: [],
      acceptanceCriteria: ["Criterion"],
      constraints: [],
      researchPlan: {
        topic: "Topic",
        timeRange: "Time",
        items: [],
        docsTargets: [],
        academicQueries: [],
        priorArtQueries: [],
      },
      assumptions: [],
      scope: "narrow",
      recommendedQuestions: [],
    },
    specAssumptions: ["[risky] Use new architecture", "Standard feature X", "Another untagged decision"],
    totalPhases: 2,
    risky: [],
    defaulted: [],
    researchSkipped: false,
    flaggedClaims: [],
    reviewText: "Review",
  };

  const result = buildApprovalTldr(input);
  assert(!("stop" in result), "Should return lines");
  const text = (result.lines as readonly string[]).join("\n");
  assert(text.includes("2 decision"), "Should mention decision count");
  assert(text.includes("without an explicit risk tag"), "Should note untagged decisions");
});

test("buildApprovalTldr: research skipped mentioned", () => {
  const input: TldrInput = {
    prd: {
      tldr: ["Build X"],
      problem: "Problem",
      users: "Users",
      inScope: ["In scope"],
      outOfScope: [],
      acceptanceCriteria: ["Criterion"],
      constraints: [],
      researchPlan: {
        topic: "Topic",
        timeRange: "Time",
        items: [],
        docsTargets: [],
        academicQueries: [],
        priorArtQueries: [],
      },
      assumptions: [],
      scope: "narrow",
      recommendedQuestions: [],
    },
    specAssumptions: [],
    totalPhases: 1,
    risky: [],
    defaulted: [],
    researchSkipped: true,
    flaggedClaims: [],
    reviewText: "Review",
  };

  const result = buildApprovalTldr(input);
  assert(!("stop" in result), "Should return lines");
  const text = (result.lines as readonly string[]).join("\n");
  assert(text.includes("Research.*skipped"), "Should mention research skipped");
});
