import { CAPABILITY_IDS } from "../../capabilities/index.js";
import { AGENT_SKILL_IDS } from "../../skills/built-ins.js";
import { CUSTOM_SKILL_IDS } from "../../skills/custom/index.js";
import {
  AGENT_WORKFLOW_PHASE_TYPES,
  AGENT_WORKFLOW_SPEC_VERSION,
  AGENT_WORKFLOW_TYPE,
} from "../schema.js";

export const RESEARCH_DOSSIER_WORKFLOW_ID = "research_dossier";

const RESEARCH_DOSSIER_TRIGGER_PATTERNS = [
  "\\b(research[_\\s-]?task|dossier|deep research|research report|risk report)\\b",
  "研究型任务|研究任务|研究档案|调研报告|风险报告|深度研究",
];

const buildQuestionTemplate = (...parts) => parts;

export const createResearchDossierWorkflowSpec = () => ({
  id: RESEARCH_DOSSIER_WORKFLOW_ID,
  version: AGENT_WORKFLOW_SPEC_VERSION,
  type: AGENT_WORKFLOW_TYPE,
  label: "Research dossier",
  description:
    "Run a staged document-grounded research dossier workflow before creating approved goal deliverables.",
  trigger: {
    patterns: RESEARCH_DOSSIER_TRIGGER_PATTERNS,
  },
  input: {
    required: ["question"],
    optional: ["docIds", "maxIterations", "sessionId", "userPreferences", "userId"],
  },
  iterationBudget: {
    maxIterations: 10,
    phaseBuffer: 4,
  },
  phases: [
    {
      id: "local_research",
      type: AGENT_WORKFLOW_PHASE_TYPES.agentQuestion,
      label: "Local document research",
      expectedSkill: AGENT_SKILL_IDS.researchBrief,
      summary: "Search selected local documents and build a cited research brief.",
      questionTemplate: buildQuestionTemplate(
        "Create a document-grounded research brief for this dossier.",
        "Use the selected local documents first. Extract key findings, cited evidence, conflicts, and unresolved gaps.",
        "Do not use web or arXiv in this step.",
        "Original goal: {{goal}}"
      ),
    },
    {
      id: "web_supplement",
      type: AGENT_WORKFLOW_PHASE_TYPES.capabilityOrAgentQuestion,
      label: "Web supplement",
      expectedCapability: CAPABILITY_IDS.webSearch,
      approvalRequired: true,
      summary: "Use current web context as supplemental, separately labeled evidence.",
      questionTemplate: buildQuestionTemplate(
        "Search the web for current external context that can supplement this research dossier.",
        "Use web context only for freshness or external validation. Keep document evidence separate from web context.",
        "Return concise findings, source links, and any uncertainty.",
        "Original goal: {{goal}}"
      ),
    },
    {
      id: "arxiv_supplement",
      type: AGENT_WORKFLOW_PHASE_TYPES.capabilityOrAgentQuestion,
      label: "arXiv supplement",
      expectedCapability: CAPABILITY_IDS.arxivImportTopic,
      approvalRequired: true,
      summary: "Search/import relevant arXiv papers for the dossier topic.",
      questionTemplate: buildQuestionTemplate(
        "Search arXiv and import the most relevant papers for this research dossier topic.",
        "Keep the import narrow and relevant to the original goal.",
        "Topic and goal: {{goal}}"
      ),
    },
    {
      id: "compare_risk_review",
      type: AGENT_WORKFLOW_PHASE_TYPES.agentQuestion,
      label: "Compare and risk review",
      summary: "Compare selected documents, then review risks and gaps.",
      variants: [
        {
          id: "multi_document",
          when: {
            minDocCount: 2,
          },
          expectedSkill: `${CUSTOM_SKILL_IDS.compareDocuments}>${CUSTOM_SKILL_IDS.riskReview}`,
          label: "Compare and risk review",
          summary: "Compare selected documents, then review risks and gaps.",
          questionTemplate: buildQuestionTemplate(
            "Compare the selected documents, then perform a citation-backed risk review.",
            "Identify common ground, differences, conflicts, missing terms, risks, gaps, exceptions, and evidence limits.",
            "Every evidence-backed bullet must include document citations.",
            "Original goal: {{goal}}"
          ),
        },
        {
          id: "single_document",
          when: {
            maxDocCount: 1,
          },
          expectedSkill: CUSTOM_SKILL_IDS.riskReview,
          label: "Risk review",
          summary: "Review risks and gaps in the selected document.",
          questionTemplate: buildQuestionTemplate(
            "Perform a citation-backed risk review for the selected document.",
            "Identify risks, gaps, conflicts, exceptions, missing terms, uncertainty, and evidence limits.",
            "Every evidence-backed bullet must include document citations.",
            "Original goal: {{goal}}"
          ),
        },
      ],
    },
    {
      id: "citation_self_check",
      type: AGENT_WORKFLOW_PHASE_TYPES.agentQuestion,
      label: "Citation self-check",
      expectedSkill: AGENT_SKILL_IDS.documentRag,
      summary: "Check supported claims, unsupported claims, and unresolved gaps.",
      questionTemplate: buildQuestionTemplate(
        "Run a citation self-check for this research dossier.",
        "Verify which claims are supported by selected document citations, which claims remain unsupported, and what gaps are unresolved.",
        "Return only supported claims, unsupported claims, unresolved gaps, and recommended follow-up retrieval questions.",
        "Original goal: {{goal}}"
      ),
    },
    {
      id: "final_dossier",
      type: AGENT_WORKFLOW_PHASE_TYPES.agentQuestion,
      label: "Final dossier",
      expectedSkill: AGENT_SKILL_IDS.documentRag,
      summary: "Synthesize the final cited dossier before report export.",
      questionTemplate: buildQuestionTemplate(
        "Create the final research dossier answer.",
        "Synthesize the local document research, external context, arXiv supplement, compare/risk review, and citation self-check into a concise cited dossier.",
        "Keep document-cited claims separate from web/arXiv context when evidence types differ. Do not invent unsupported claims.",
        "End with unresolved gaps and follow-up actions.",
        "Original goal: {{goal}}"
      ),
    },
  ],
  deliverables: [
    {
      artifactType: "document_organization",
      capabilityId: CAPABILITY_IDS.documentOrganize,
      label: "Document organization",
      optional: true,
      triggerPatterns: [
        "\\b(organize|organise|arrange|group|cluster)\\b|整理|归类|分类",
      ],
    },
    {
      artifactType: "markdown_report",
      capabilityId: CAPABILITY_IDS.reportExport,
      label: "Markdown report",
    },
    {
      artifactType: "saved_summary",
      capabilityId: CAPABILITY_IDS.summaryCreate,
      label: "Saved summary",
    },
    {
      artifactType: "follow_up_task",
      capabilityId: CAPABILITY_IDS.taskCreate,
      label: "Follow-up task",
    },
  ],
  completionChecks: [
    "terminal_status_completed",
    "plan_steps_completed",
    "evidence_gaps_resolved",
    "deliverables_created",
    "no_pending_user_action",
    "research_phases_completed",
  ],
  metadata: {
    source: "built_in",
  },
});
