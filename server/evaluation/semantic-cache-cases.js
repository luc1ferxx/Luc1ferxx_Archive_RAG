// The constructed question sets for the semantic answer cache evaluation
// (run-semantic-cache-eval.mjs).
//
// SEMANTIC_CACHE_CASES (in-category) runs live over the five documents of
// synthetic-corpus-5docs.json. Its contrasts are drawn from the categories the
// first guard was written for, so a clean result on them says little about
// other kinds of look-alike question; report it as "in-category". Each group
// asks a base question first (a cache miss that stores the answer when the
// RAG path answers it), then follow-ups against the same cache:
//
//   repeat      the same question again, or the same words with other case,
//               spacing or punctuation. A hit is expected.
//   paraphrase  the same meaning in other words. A hit is allowed, never
//               required; the hit rate on these is what the threshold trades.
//   contrast    a look-alike question with a different meaning. A hit is a
//               false hit and must not happen. `category` names what differs:
//               negation, number, date, entity (named or a rival common noun
//               such as "hotel" for "meal"), role (the same words with two
//               parties swapped), document (another doc set) or tenant
//               (another user in the same workspace).
//
// A follow-up without `docKeys` uses its group's documents; one without
// `tenant` asks as its group's tenant.
//
// SEMANTIC_CACHE_HELD_OUT_PAIRS (below) are question pairs outside those
// categories, split in two: `tune` holds the review's probes that showed the
// first guard's holes (the guard was rebuilt after reading them), `confirm`
// holds pairs written after the rebuild for the same categories plus a few
// the review did not name. They were written by the guard's author, so
// `confirm` is held out from the tuning, not blind.

export const SEMANTIC_CACHE_CASE_SET_VERSION = "semantic-cache-cases/v2";

export const SEMANTIC_CACHE_FOLLOW_UP_KINDS = Object.freeze(["repeat", "paraphrase", "contrast"]);

export const SEMANTIC_CACHE_CONTRAST_CATEGORIES = Object.freeze([
  "negation",
  "number",
  "date",
  "entity",
  "role",
  "document",
  "tenant",
]);

export const SEMANTIC_CACHE_TENANTS = Object.freeze({
  alice: Object.freeze({ userId: "alice", workspaceId: "ws-cache-eval" }),
  bob: Object.freeze({ userId: "bob", workspaceId: "ws-cache-eval" }),
});

export const SEMANTIC_CACHE_CASES = Object.freeze([
  {
    id: "leave_days_2023",
    docKeys: ["benefits_2023"],
    tenant: "alice",
    base: "How many paid annual leave days do employees receive per year?",
    followUps: [
      { kind: "repeat", question: "How many paid annual leave days do employees receive per year?" },
      { kind: "repeat", question: "how many paid annual leave days do employees receive per year" },
      { kind: "paraphrase", question: "How many paid annual leave days do employees get per year?" },
      { kind: "paraphrase", question: "Per year, how many paid annual leave days do employees receive?" },
      { kind: "paraphrase", question: "How many days of paid annual leave do employees receive each year?" },
      {
        kind: "contrast",
        category: "document",
        docKeys: ["benefits_2024"],
        question: "How many paid annual leave days do employees receive per year?",
      },
      {
        kind: "contrast",
        category: "tenant",
        tenant: "bob",
        question: "How many paid annual leave days do employees receive per year?",
      },
      { kind: "contrast", category: "entity", question: "How many paid sick leave days do employees receive per year?" },
      { kind: "contrast", category: "number", question: "Do employees receive 10 paid annual leave days per year?" },
    ],
  },
  {
    id: "carry_over_2025_2026",
    docKeys: ["benefits_2025", "benefits_2026"],
    tenant: "alice",
    base: "How many unused leave days may be carried over into the next year?",
    followUps: [
      { kind: "repeat", question: "How many unused leave days may be carried over into the next year?" },
      { kind: "paraphrase", question: "How many unused leave days can be carried over into the next year?" },
      { kind: "paraphrase", question: "How many unused leave days may employees carry over into the next year?" },
      { kind: "contrast", category: "negation", question: "How many unused leave days may not be carried over into the next year?" },
      { kind: "contrast", category: "number", question: "May 5 unused leave days be carried over into the next year?" },
      {
        kind: "contrast",
        category: "document",
        docKeys: ["benefits_2025"],
        question: "How many unused leave days may be carried over into the next year?",
      },
    ],
  },
  {
    id: "remote_days_three_policies",
    docKeys: ["benefits_2024", "benefits_2025", "benefits_2026"],
    tenant: "alice",
    base: "Which policy allows employees to work remotely 3 days per week?",
    followUps: [
      { kind: "repeat", question: "Which policy allows employees to work remotely 3 days per week?" },
      { kind: "repeat", question: "Which policy allows employees to work remotely 3 days per week ?" },
      { kind: "paraphrase", question: "Which policy lets employees work remotely 3 days per week?" },
      { kind: "paraphrase", question: "Which policy allows employees to work remotely three days per week?" },
      { kind: "contrast", category: "number", question: "Which policy allows employees to work remotely 4 days per week?" },
      { kind: "contrast", category: "number", question: "Which policy allows employees to work remotely 2 days per week?" },
      { kind: "contrast", category: "negation", question: "Which policy does not allow employees to work remotely 3 days per week?" },
    ],
  },
  {
    id: "meal_limit_2024_contractor",
    docKeys: ["benefits_2024", "contractor_handbook"],
    tenant: "alice",
    base: "What is the meal reimbursement limit per day?",
    followUps: [
      { kind: "repeat", question: "What is the meal reimbursement limit per day?" },
      { kind: "repeat", question: "WHAT IS THE MEAL REIMBURSEMENT LIMIT PER DAY?" },
      { kind: "paraphrase", question: "What is the daily meal reimbursement limit?" },
      { kind: "paraphrase", question: "What's the meal reimbursement limit per day?" },
      { kind: "contrast", category: "entity", question: "What is the hotel reimbursement limit per day?" },
      { kind: "contrast", category: "entity", question: "What is the hotel reimbursement limit per night?" },
      {
        kind: "contrast",
        category: "document",
        docKeys: ["benefits_2025", "contractor_handbook"],
        question: "What is the meal reimbursement limit per day?",
      },
    ],
  },
  {
    id: "remote_approval_2026",
    docKeys: ["benefits_2026"],
    tenant: "alice",
    base: "Who must approve remote work for employees?",
    followUps: [
      { kind: "repeat", question: "Who must approve remote work for employees?" },
      { kind: "paraphrase", question: "Who has to approve remote work for employees?" },
      { kind: "paraphrase", question: "Whose approval do employees need to work remotely?" },
      { kind: "contrast", category: "entity", question: "Who must approve remote work for contractors?" },
      { kind: "contrast", category: "negation", question: "Who does not need to approve remote work for employees?" },
    ],
  },
  {
    id: "meal_limit_by_year",
    docKeys: ["benefits_2023", "benefits_2024", "benefits_2025", "benefits_2026"],
    tenant: "alice",
    base: "What was the meal reimbursement limit in 2024?",
    followUps: [
      { kind: "repeat", question: "What was the meal reimbursement limit in 2024?" },
      { kind: "paraphrase", question: "What was the meal reimbursement limit during 2024?" },
      { kind: "contrast", category: "date", question: "What was the meal reimbursement limit in 2025?" },
      { kind: "contrast", category: "date", question: "What was the meal reimbursement limit in 2023?" },
      { kind: "contrast", category: "date", question: "What was the meal reimbursement limit in March 2024?" },
    ],
  },
  {
    id: "contractor_handbook_hotel",
    docKeys: ["benefits_2024", "contractor_handbook"],
    tenant: "alice",
    base: "What does the Contractor Handbook say about hotel reimbursement?",
    followUps: [
      { kind: "repeat", question: "What does the Contractor Handbook say about hotel reimbursement?" },
      { kind: "paraphrase", question: "What does the Contractor Handbook state about hotel reimbursement?" },
      { kind: "contrast", category: "entity", question: "What does the Benefits Handbook say about hotel reimbursement?" },
      { kind: "contrast", category: "entity", question: "What does the Employee Handbook say about hotel reimbursement?" },
    ],
  },
  {
    id: "unused_leave_contractor",
    docKeys: ["contractor_handbook"],
    tenant: "alice",
    base: "What happens to unused annual leave at the end of the year?",
    followUps: [
      { kind: "repeat", question: "What happens to unused annual leave at the end of the year?" },
      { kind: "paraphrase", question: "What happens to unused annual leave when the year ends?" },
      { kind: "contrast", category: "negation", question: "What does not happen to unused annual leave at the end of the year?" },
      { kind: "contrast", category: "date", question: "What happens to unused annual leave at the end of the quarter?" },
      {
        kind: "contrast",
        category: "document",
        docKeys: ["benefits_2023"],
        question: "What happens to unused annual leave at the end of the year?",
      },
    ],
  },
  {
    id: "hotel_pre_approval",
    docKeys: ["contractor_handbook"],
    tenant: "alice",
    base: "Is pre-approval required before booking a hotel?",
    followUps: [
      { kind: "repeat", question: "Is pre-approval required before booking a hotel?" },
      { kind: "paraphrase", question: "Is pre-approval needed before booking a hotel?" },
      { kind: "contrast", category: "negation", question: "Is pre-approval not required before booking a hotel?" },
      { kind: "contrast", category: "negation", question: "Can a hotel be booked without pre-approval?" },
    ],
  },
  {
    id: "compare_meal_limits",
    docKeys: ["benefits_2024", "benefits_2025", "benefits_2026"],
    tenant: "alice",
    base: "Compare the meal reimbursement limit in these documents.",
    followUps: [
      { kind: "repeat", question: "Compare the meal reimbursement limit in these documents." },
      { kind: "paraphrase", question: "Compare the meal reimbursement limits in these documents." },
      { kind: "contrast", category: "entity", question: "Compare the remote work policy in these documents." },
      {
        kind: "contrast",
        category: "document",
        docKeys: ["benefits_2023", "benefits_2024", "benefits_2025"],
        question: "Compare the meal reimbursement limit in these documents.",
      },
    ],
  },
  {
    id: "leave_employees_vs_contractors",
    docKeys: ["benefits_2024", "contractor_handbook"],
    tenant: "alice",
    base: "Do employees receive more paid annual leave days than contractors?",
    followUps: [
      { kind: "repeat", question: "Do employees receive more paid annual leave days than contractors?" },
      { kind: "paraphrase", question: "Do employees get more paid annual leave days than contractors?" },
      { kind: "contrast", category: "role", question: "Do contractors receive more paid annual leave days than employees?" },
      { kind: "contrast", category: "negation", question: "Do employees receive fewer paid annual leave days than contractors?" },
    ],
  },
  {
    id: "remote_approval_contractor_roles",
    docKeys: ["contractor_handbook"],
    tenant: "alice",
    base: "Must the program lead approve remote work for contractors?",
    followUps: [
      { kind: "repeat", question: "must the program lead approve remote work for contractors" },
      { kind: "paraphrase", question: "Does the program lead have to approve remote work for contractors?" },
      { kind: "contrast", category: "role", question: "Must the contractors approve remote work for the program lead?" },
      { kind: "contrast", category: "entity", question: "Must the department head approve remote work for contractors?" },
    ],
  },
  {
    // One swapped word in a long question: nomic-embed-text scores these
    // 0.95-0.995 against the base, so only the guard separates them.
    id: "long_question_one_word_swaps",
    docKeys: ["benefits_2024"],
    tenant: "alice",
    base: "Under the benefits policy that applies to all offices, how many paid annual leave days do employees receive per year once they have completed their probation?",
    followUps: [
      {
        kind: "paraphrase",
        question: "Under the benefits policy that applies to all offices, how many paid annual leave days do employees get per year once they have completed their probation?",
      },
      {
        kind: "contrast",
        category: "entity",
        question: "Under the benefits policy that applies to all regions, how many paid annual leave days do employees receive per year once they have completed their probation?",
      },
      {
        kind: "contrast",
        category: "entity",
        question: "Under the benefits policy that applies to all offices, how many paid annual leave days do employees receive per year once they have started their probation?",
      },
      {
        kind: "contrast",
        category: "entity",
        question: "Under the benefits policy that applies to all offices, how many paid sick leave days do employees receive per year once they have completed their probation?",
      },
      {
        kind: "contrast",
        category: "negation",
        question: "Under the benefits policy that applies to all offices, how many unpaid annual leave days do employees receive per year once they have completed their probation?",
      },
    ],
  },
  {
    // The English embedding model scores 带薪年假 / 带薪病假 at 0.992.
    id: "chinese_leave_days",
    docKeys: ["benefits_2024"],
    tenant: "alice",
    base: "员工每年有多少天带薪年假？",
    followUps: [
      { kind: "repeat", question: "员工每年有多少天带薪年假?" },
      { kind: "contrast", category: "entity", question: "员工每年有多少天带薪病假？" },
    ],
  },
]);

/** The follow-ups of every case with their effective documents and tenant. */
export const expandSemanticCacheFollowUps = (cases = SEMANTIC_CACHE_CASES) =>
  cases.flatMap((entry) =>
    entry.followUps.map((followUp, index) => ({
      caseId: entry.id,
      id: `${entry.id}#${index + 1}`,
      kind: followUp.kind,
      category: followUp.category ?? null,
      question: followUp.question,
      baseQuestion: entry.base,
      docKeys: followUp.docKeys ?? entry.docKeys,
      baseDocKeys: entry.docKeys,
      tenant: followUp.tenant ?? entry.tenant,
      baseTenant: entry.tenant,
    }))
  );

export const SEMANTIC_CACHE_HELD_OUT_SPLITS = Object.freeze(["tune", "confirm"]);

export const SEMANTIC_CACHE_HELD_OUT_CATEGORIES = Object.freeze([
  "modal",
  "direction",
  "negation_scope",
  "comparator",
  "pronoun",
  "relative_time",
  "tense",
  "non_latin",
  // Not named by the review.
  "wh_word",
  "quantifier",
  "conjunction",
]);

const pair = (split, kind, category, base, question) => ({ split, kind, category, base, question });
const tuneContrast = (category, base, question) => pair("tune", "contrast", category, base, question);
const confirmContrast = (category, base, question) => pair("confirm", "contrast", category, base, question);
const confirmParaphrase = (base, question) => pair("confirm", "paraphrase", null, base, question);

/**
 * Offline pairs: each `question` is asked against its own stored `base`.
 * A contrast hit is a false hit; a paraphrase hit is allowed.
 */
export const SEMANTIC_CACHE_HELD_OUT_PAIRS = Object.freeze(
  [
    // ---- tune: the review's probes ------------------------------------------
    tuneContrast("modal", "Can employees work remotely on Fridays?", "Must employees work remotely on Fridays?"),
    tuneContrast("modal", "Can employees use the corporate card for personal expenses?", "Must employees use the corporate card for personal expenses?"),
    tuneContrast("modal", "Should managers approve overtime requests?", "Can managers approve overtime requests?"),
    tuneContrast("direction", "Can employees transfer unused leave to another employee?", "Can employees transfer unused leave from another employee?"),
    tuneContrast("direction", "Can an employee move from the sales team to the marketing team?", "Can an employee move to the sales team from the marketing team?"),
    tuneContrast("negation_scope", "Is pre-approval required when the trip is not international?", "Is pre-approval not required when the trip is international?"),
    tuneContrast("negation_scope", "Are receipts required when the expense is not reimbursed?", "Are receipts not required when the expense is reimbursed?"),
    tuneContrast("comparator", "Are expenses > $500 reimbursed without approval?", "Are expenses < $500 reimbursed without approval?"),
    tuneContrast("pronoun", "Can my manager see his performance review?", "Can his manager see my performance review?"),
    tuneContrast("non_latin", "Требуется ли предварительное одобрение для командировки?", "Не требуется ли предварительное одобрение для командировки?"),
    tuneContrast("non_latin", "Сколько дней ежегодного оплачиваемого отпуска получают сотрудники?", "Сколько дней оплачиваемого больничного получают сотрудники?"),
    tuneContrast("non_latin", "Πόσες ημέρες άδειας δικαιούνται οι υπάλληλοι;", "Πόσες ημέρες άδειας δικαιούνται οι εξωτερικοί συνεργάτες;"),

    // ---- confirm: written after the rebuild ---------------------------------
    confirmContrast("modal", "May contractors work from home on Mondays?", "Must contractors work from home on Mondays?"),
    confirmContrast("modal", "Could the finance team reject a travel claim?", "Should the finance team reject a travel claim?"),
    confirmContrast("modal", "Can interns attend the annual offsite?", "Will interns attend the annual offsite?"),
    confirmContrast("modal", "Do employees have to submit receipts for meals?", "Can employees submit receipts for meals?"),
    confirmContrast("modal", "Must new hires complete security training?", "May new hires complete security training?"),
    confirmContrast("modal", "Will the company pay for relocation costs?", "Can the company pay for relocation costs?"),

    confirmContrast("direction", "Is leave transferred from the old system to the new system?", "Is leave transferred to the old system from the new system?"),
    confirmContrast("direction", "Who reports to the regional director?", "Who does the regional director report to?"),
    confirmContrast("direction", "Can funds be moved into the travel budget?", "Can funds be moved out of the travel budget?"),
    confirmContrast("direction", "How are invoices sent by the vendor to the customer?", "How are invoices sent by the customer to the vendor?"),
    confirmContrast("direction", "Can a contractor convert to an employee?", "Can an employee convert to a contractor?"),
    confirmContrast("direction", "Do reimbursements go to the employee's bank account?", "Do reimbursements come from the employee's bank account?"),

    confirmContrast("negation_scope", "Are meals reimbursed if the receipt is not itemized?", "Are meals not reimbursed if the receipt is itemized?"),
    confirmContrast("negation_scope", "Is manager approval needed when the request is not urgent?", "Is manager approval not needed when the request is urgent?"),
    confirmContrast("negation_scope", "Which employees are not eligible for the bonus if they joined this year?", "Which employees are eligible for the bonus if they did not join this year?"),
    confirmContrast("negation_scope", "Does the policy apply to staff who do not work remotely?", "Does the policy not apply to staff who work remotely?"),
    confirmContrast("negation_scope", "Is travel insurance required for trips that are not booked through the portal?", "Is travel insurance not required for trips that are booked through the portal?"),
    confirmContrast("negation_scope", "Do contractors get paid when the project is not finished?", "Do contractors not get paid when the project is finished?"),

    confirmContrast("comparator", "Are purchases ≥ $1,000 subject to review?", "Are purchases ≤ $1,000 subject to review?"),
    confirmContrast("comparator", "Do trips > 5 days need approval?", "Do trips < 5 days need approval?"),
    confirmContrast("comparator", "Is a bonus paid when sales >= 100%?", "Is a bonus paid when sales <= 100%?"),
    confirmContrast("comparator", "Are expenses of €200 or more reimbursed?", "Are expenses of €200 or less reimbursed?"),
    confirmContrast("comparator", "Can employees spend at least $50 per day on meals?", "Can employees spend at most $50 per day on meals?"),
    confirmContrast("comparator", "Are gifts worth over $100 declared?", "Are gifts worth under $100 declared?"),

    confirmContrast("pronoun", "Can I see my colleague's salary?", "Can my colleague see my salary?"),
    confirmContrast("pronoun", "Does she approve his expenses?", "Does he approve her expenses?"),
    confirmContrast("pronoun", "Can we share our reports with them?", "Can they share their reports with us?"),
    confirmContrast("pronoun", "Who approves your leave requests?", "Who approves my leave requests?"),
    confirmContrast("pronoun", "Can they access our documents?", "Can we access their documents?"),
    confirmContrast("pronoun", "Does the manager review her own timesheet?", "Does the manager review his own timesheet?"),

    confirmContrast("relative_time", "How much leave accrues within the first year?", "How much leave accrues after the first year?"),
    confirmContrast("relative_time", "Is remote work allowed during probation?", "Is remote work allowed after probation?"),
    confirmContrast("relative_time", "What expenses were reimbursed last quarter?", "What expenses were reimbursed this quarter?"),
    confirmContrast("relative_time", "Which benefits start 30 days before the hire date?", "Which benefits start 30 days after the hire date?"),
    confirmContrast("relative_time", "Must receipts be submitted within 30 days of travel?", "Must receipts be submitted 30 days after travel?"),
    confirmContrast("relative_time", "What happens to leave carried over until next year?", "What happens to leave carried over since last year?"),

    confirmContrast("tense", "Was remote work allowed on Fridays?", "Is remote work allowed on Fridays?"),
    confirmContrast("tense", "Who approved the travel budget?", "Who approves the travel budget?"),
    confirmContrast("tense", "Did contractors receive a year-end bonus?", "Do contractors receive a year-end bonus?"),
    confirmContrast("tense", "What was the meal allowance for interns?", "What is the meal allowance for interns?"),
    confirmContrast("tense", "Has the hotel limit been increased?", "Will the hotel limit be increased?"),
    confirmContrast("tense", "Which teams used the shared car pool?", "Which teams use the shared car pool?"),

    confirmContrast("non_latin", "Могут ли сотрудники работать удалённо по пятницам?", "Должны ли сотрудники работать удалённо по пятницам?"),
    confirmContrast("non_latin", "Απαιτείται έγκριση για ταξίδια στο εξωτερικό;", "Δεν απαιτείται έγκριση για ταξίδια στο εξωτερικό;"),
    confirmContrast("non_latin", "هل يحتاج الموظفون إلى موافقة مسبقة للسفر؟", "هل لا يحتاج الموظفون إلى موافقة مسبقة للسفر؟"),
    confirmContrast("non_latin", "כמה ימי חופשה מקבלים העובדים?", "כמה ימי מחלה מקבלים העובדים?"),
    confirmContrast("non_latin", "พนักงานได้รับวันลาพักร้อนกี่วัน", "พนักงานได้รับวันลาป่วยกี่วัน"),
    confirmContrast("non_latin", "क्या कर्मचारियों को यात्रा के लिए पूर्व अनुमोदन चाहिए?", "क्या ठेकेदारों को यात्रा के लिए पूर्व अनुमोदन चाहिए?"),
    confirmContrast("non_latin", "従業員は年間何日の有給休暇を取得できますか？", "契約社員は年間何日の有給休暇を取得できますか？"),
    confirmContrast("non_latin", "직원은 연간 며칠의 유급 휴가를 받나요?", "계약자는 연간 며칠의 유급 휴가를 받나요?"),

    confirmContrast("wh_word", "Who approves remote work for contractors?", "When is remote work for contractors approved?"),
    confirmContrast("wh_word", "Where are expense reports submitted?", "When are expense reports submitted?"),
    confirmContrast("wh_word", "Why was the travel request rejected?", "When was the travel request rejected?"),

    confirmContrast("quantifier", "Do all employees receive a laptop?", "Do some employees receive a laptop?"),
    confirmContrast("quantifier", "Are any contractors eligible for the bonus?", "Are only contractors eligible for the bonus?"),
    confirmContrast("quantifier", "Does every team get a parking space?", "Does one team get a parking space?"),

    confirmContrast("conjunction", "Are hotel and meal costs reimbursed?", "Are hotel or meal costs reimbursed?"),
    confirmContrast("conjunction", "Can employees work remotely and travel in the same week?", "Can employees work remotely or travel in the same week?"),
    confirmContrast("conjunction", "Is approval needed for hotels but not for meals?", "Is approval needed for meals but not for hotels?"),

    // Paraphrases: some use a rewrite the guard allows, most are ordinary
    // rewordings it does not know.
    confirmParaphrase("How many vacation days do new employees get?", "How many vacation days do new employees receive?"),
    confirmParaphrase("What is the maximum hotel rate per night?", "What's the maximum hotel rate per night?"),
    confirmParaphrase("Can contractors work remotely?", "May contractors work remotely?"),
    confirmParaphrase("Who has to sign the travel request?", "Who must sign the travel request?"),
    confirmParaphrase("Is a receipt needed for taxi rides?", "Is a receipt required for taxi rides?"),
    confirmParaphrase("What does the handbook say about parking?", "What does the handbook state about parking?"),
    confirmParaphrase("How much is the daily meal allowance?", "How much is the meal allowance per day?"),
    confirmParaphrase("Which expenses need manager approval?", "Which expenses require manager approval?"),
    confirmParaphrase("Are employees allowed to bring pets to the office?", "Are employees permitted to bring pets to the office?"),
    confirmParaphrase("How many days per week can staff work from home?", "How many days a week can staff work from home?"),
    confirmParaphrase("WHAT IS THE MILEAGE RATE FOR PERSONAL CARS?", "What is the mileage rate for personal cars?"),
    confirmParaphrase("Who approves expense reports over 500 dollars?", "Who approves expense reports over five hundred dollars?"),
    confirmParaphrase("Сколько дней отпуска получают сотрудники?", "Сколько дней отпуска получают сотрудники"),
    confirmParaphrase("When does the open enrollment period start?", "When does open enrollment start?"),
    confirmParaphrase("What is the policy on remote work?", "What is the remote work policy?"),
    confirmParaphrase("How many sick days are employees entitled to?", "How many sick days do employees get?"),
    confirmParaphrase("Is overtime paid for part-time staff?", "Do part-time staff get paid for overtime?"),
    confirmParaphrase("What are the rules for booking flights?", "What are the flight booking rules?"),
    confirmParaphrase("Can I expense a taxi to the airport?", "Can I claim a taxi to the airport as an expense?"),
    confirmParaphrase("Does the company cover home office equipment?", "Does the company pay for home office equipment?"),
    confirmParaphrase("How long is the probation period?", "What is the length of the probation period?"),
  ].map((entry, index) => Object.freeze({ id: `held-out-${entry.split}-${index + 1}`, ...entry }))
);
