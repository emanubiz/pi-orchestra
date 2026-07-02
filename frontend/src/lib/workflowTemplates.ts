/**
 * Built-in workflow templates — pre-configured multi-agent graphs that users
 * can instantiate with one click from the empty-state gallery or the
 * WorkflowPicker. Each template is a valid `WorkflowGraph` that plugs directly
 * into the existing `loadWorkflow()` flow.
 *
 * Prompt IDs reference the built-in seeds in `backend/src/db/index.ts`.
 * Node positions are spaced for a comfortable default canvas layout.
 */

import type { WorkflowGraph } from "../types";

export interface WorkflowTemplate {
  /** Stable identifier (used as `WorkflowGraph.id` on save). */
  id: string;
  /** Human-readable name shown in the gallery. */
  name: string;
  /** Short description shown under the name. */
  description: string;
  /** Emoji icon for the gallery card. */
  icon: string;
  /** Category tag for grouping. */
  category: "coding" | "research" | "content";
  /** The graph to load. */
  graph: WorkflowGraph;
}

const X_GAP = 340;
const Y_BASE = 120;

// ── Templates ────────────────────────────────────────────────────────────────

const docsCleanup: WorkflowTemplate = {
  id: "tpl-docs-cleanup",
  name: "Docs Cleanup Loop",
  description: "Architect plans structure, writer edits, reviewer validates. Loops up to 2×.",
  icon: "📝",
  category: "coding",
  graph: {
    id: "tpl-docs-cleanup",
    name: "Docs Cleanup Loop",
    entryNodeId: "t-arch",
    nodes: [
      {
        id: "t-arch",
        label: "Architect",
        promptId: "builtin-architect",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE },
      },
      {
        id: "t-writer",
        label: "Technical Writer",
        promptId: "builtin-writer",
        canBeFinal: false,
        position: { x: X_GAP, y: Y_BASE },
      },
      {
        id: "t-reviewer",
        label: "Reviewer",
        promptId: "builtin-auditor",
        canBeFinal: true,
        position: { x: X_GAP * 2, y: Y_BASE },
      },
    ],
    edges: [
      { id: "te-aw", sourceNodeId: "t-arch", targetNodeId: "t-writer" },
      { id: "te-wr", sourceNodeId: "t-writer", targetNodeId: "t-reviewer" },
      { id: "te-rw", sourceNodeId: "t-reviewer", targetNodeId: "t-writer" },
    ],
  },
};

const featureBuild: WorkflowTemplate = {
  id: "tpl-feature-build",
  name: "Feature Build",
  description: "Full pipeline: architect designs, developer implements, QA tests, auditor reviews.",
  icon: "🏗️",
  category: "coding",
  graph: {
    id: "tpl-feature-build",
    name: "Feature Build",
    entryNodeId: "t-arch2",
    nodes: [
      {
        id: "t-arch2",
        label: "Architect",
        promptId: "builtin-architect",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE },
      },
      {
        id: "t-dev",
        label: "Developer",
        promptId: "builtin-developer",
        canBeFinal: false,
        position: { x: X_GAP, y: Y_BASE },
      },
      {
        id: "t-qa",
        label: "QA Engineer",
        promptId: "builtin-qa",
        canBeFinal: false,
        position: { x: X_GAP * 2, y: Y_BASE },
      },
      {
        id: "t-audit",
        label: "Auditor",
        promptId: "builtin-auditor",
        canBeFinal: true,
        position: { x: X_GAP * 3, y: Y_BASE },
      },
    ],
    edges: [
      { id: "te-ad", sourceNodeId: "t-arch2", targetNodeId: "t-dev" },
      { id: "te-dq", sourceNodeId: "t-dev", targetNodeId: "t-qa" },
      { id: "te-qa-aud", sourceNodeId: "t-qa", targetNodeId: "t-audit" },
      // Auditor can send back to developer for fixes
      { id: "te-aud-d", sourceNodeId: "t-audit", targetNodeId: "t-dev" },
    ],
  },
};

const bugfixTriage: WorkflowTemplate = {
  id: "tpl-bugfix-triage",
  name: "Bugfix Triage",
  description: "Analyst diagnoses, developer fixes, QA verifies. Lean 3-node loop.",
  icon: "🐛",
  category: "coding",
  graph: {
    id: "tpl-bugfix-triage",
    name: "Bugfix Triage",
    entryNodeId: "t-analyst",
    nodes: [
      {
        id: "t-analyst",
        label: "Analyst",
        promptId: "builtin-analyst",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE },
      },
      {
        id: "t-dev2",
        label: "Developer",
        promptId: "builtin-developer",
        canBeFinal: false,
        position: { x: X_GAP, y: Y_BASE },
      },
      {
        id: "t-qa2",
        label: "QA Engineer",
        promptId: "builtin-qa",
        canBeFinal: true,
        position: { x: X_GAP * 2, y: Y_BASE },
      },
    ],
    edges: [
      { id: "te-an-dev", sourceNodeId: "t-analyst", targetNodeId: "t-dev2" },
      { id: "te-dev-qa", sourceNodeId: "t-dev2", targetNodeId: "t-qa2" },
      { id: "te-qa-dev", sourceNodeId: "t-qa2", targetNodeId: "t-dev2" },
    ],
  },
};

const codeReview: WorkflowTemplate = {
  id: "tpl-code-review",
  name: "Code Review",
  description: "Security + design review in parallel, then an auditor synthesizes findings.",
  icon: "🔍",
  category: "coding",
  graph: {
    id: "tpl-code-review",
    name: "Code Review",
    entryNodeId: "t-sec",
    nodes: [
      {
        id: "t-sec",
        label: "Security Reviewer",
        promptId: "builtin-security-reviewer",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE - 60 },
      },
      {
        id: "t-design",
        label: "Design Reviewer",
        promptId: "builtin-design-reviewer",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE + 60 },
      },
      {
        id: "t-audit2",
        label: "Auditor",
        promptId: "builtin-auditor",
        canBeFinal: true,
        position: { x: X_GAP, y: Y_BASE },
      },
    ],
    edges: [
      { id: "te-sec-aud", sourceNodeId: "t-sec", targetNodeId: "t-audit2" },
      { id: "te-des-aud", sourceNodeId: "t-design", targetNodeId: "t-audit2" },
    ],
  },
};

const researchSynthesis: WorkflowTemplate = {
  id: "tpl-research",
  name: "Research Synthesis",
  description: "Researcher gathers, fact-checker verifies, report writer produces the final deliverable.",
  icon: "🔬",
  category: "research",
  graph: {
    id: "tpl-research",
    name: "Research Synthesis",
    entryNodeId: "t-res",
    nodes: [
      {
        id: "t-res",
        label: "Researcher",
        promptId: "builtin-researcher",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE },
      },
      {
        id: "t-fc",
        label: "Fact-Checker",
        promptId: "builtin-fact-checker",
        canBeFinal: false,
        position: { x: X_GAP, y: Y_BASE },
      },
      {
        id: "t-rw2",
        label: "Report Writer",
        promptId: "builtin-report-writer",
        canBeFinal: true,
        position: { x: X_GAP * 2, y: Y_BASE },
      },
    ],
    edges: [
      { id: "te-res-fc", sourceNodeId: "t-res", targetNodeId: "t-fc" },
      { id: "te-fc-rw", sourceNodeId: "t-fc", targetNodeId: "t-rw2" },
      // Fact-checker can send back for more research
      { id: "te-fc-res", sourceNodeId: "t-fc", targetNodeId: "t-res" },
    ],
  },
};

const contentPipeline: WorkflowTemplate = {
  id: "tpl-content",
  name: "Content Pipeline",
  description: "Strategist plans, writer drafts, copy editor polishes, proofreader finalizes with SEO.",
  icon: "✍️",
  category: "content",
  graph: {
    id: "tpl-content",
    name: "Content Pipeline",
    entryNodeId: "t-cs",
    nodes: [
      {
        id: "t-cs",
        label: "Content Strategist",
        promptId: "builtin-content-strategist",
        canBeFinal: false,
        position: { x: 0, y: Y_BASE },
      },
      {
        id: "t-cw",
        label: "Writer",
        promptId: "builtin-content-writer",
        canBeFinal: false,
        position: { x: X_GAP, y: Y_BASE },
      },
      {
        id: "t-ce",
        label: "Copy Editor",
        promptId: "builtin-copy-editor",
        canBeFinal: false,
        position: { x: X_GAP * 2, y: Y_BASE },
      },
      {
        id: "t-seo",
        label: "Proofreader & SEO",
        promptId: "builtin-proofreader-seo",
        canBeFinal: true,
        position: { x: X_GAP * 3, y: Y_BASE },
      },
    ],
    edges: [
      { id: "te-cs-cw", sourceNodeId: "t-cs", targetNodeId: "t-cw" },
      { id: "te-cw-ce", sourceNodeId: "t-cw", targetNodeId: "t-ce" },
      { id: "te-ce-seo", sourceNodeId: "t-ce", targetNodeId: "t-seo" },
      // Copy editor can send back to writer
      { id: "te-ce-cw", sourceNodeId: "t-ce", targetNodeId: "t-cw" },
    ],
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  featureBuild,
  docsCleanup,
  bugfixTriage,
  codeReview,
  researchSynthesis,
  contentPipeline,
];


