// office-format-eval.js
//
// Office files against the PDFs Office exports from them: the pure parts that
// build-office-format-corpus.mjs (the corpus, made by Word, PowerPoint and
// Excel through AppleScript) and run-office-format-eval.mjs (the questions)
// share. Every document is there twice, as the Office file and as the PDF its
// own application exported, and every question is asked of both:
//
//   word   QASPER train papers set as Word documents (title, Abstract and each
//          section a Heading 1, subsections a Heading 2); the answerable
//          questions whose evidence is text. Official QASPER answer F1.
//   sheet  synthetic workbooks, one data sheet each (a key column and five
//          typed columns); cell lookup questions with the displayed value as
//          the gold answer.
//   deck   synthetic decks made in PowerPoint: a title slide and four content
//          slides of three fact bullets, two of them with a fact in the
//          speaker notes. Questions about bullets ("body") and about notes
//          ("notes"); a PDF export carries no notes, so notes questions are
//          reported apart and never paired.
//
// Everything here is deterministic for a seed (createSeededRandom).

import { describeQasperAnswer } from "./import-qasper.mjs";
import {
  bootstrapClusterMeanInterval,
  bootstrapMeanInterval,
  createSeededRandom,
  roundTo4,
} from "./paired-bootstrap.js";
import { normalizeQasperAnswer, qasperAnswerF1, toQasperPrediction } from "./qasper-answer-metrics.js";

export const OFFICE_FORMAT_CORPORA = Object.freeze(["word", "sheet", "deck"]);
export const CORPUS_FORMATS = Object.freeze({ deck: "pptx", sheet: "xlsx", word: "docx" });
export const OFFICE_FORMAT_ARMS = Object.freeze(["native", "pdf"]);
export const MANIFEST_VERSION = 1;

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

export const integerBetween = (random, min, max) => min + Math.floor(random() * (max - min + 1));

export const shuffled = (random, items) => {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));

    [copy[index], copy[other]] = [copy[other], copy[index]];
  }

  return copy;
};

/** Draws without replacement from `items`; throws once they run out. */
export const createDrawer = (random, items, label) => {
  const queue = shuffled(random, items);

  return () => {
    if (queue.length === 0) {
      throw new Error(`Ran out of ${label}.`);
    }

    return queue.pop();
  };
};

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const FIRST_NAMES = Object.freeze([
  "Amara", "Bruno", "Chen", "Dalia", "Emeka", "Farah", "Goran", "Hana", "Ines", "Jonas", "Kenji", "Leila",
  "Mateo", "Nadia", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tariq", "Uma", "Viktor", "Wen", "Ximena",
  "Yusuf", "Zara", "Aiko", "Bilal", "Camila", "Dmitri", "Elena", "Felix", "Grace", "Hugo", "Ivy", "Javier",
  "Kofi", "Lucia", "Malik", "Nora",
]);
const LAST_NAMES = Object.freeze([
  "Abara", "Bianchi", "Castillo", "Dubois", "Eriksen", "Fischer", "Garcia", "Haddad", "Ivanova", "Jensen",
  "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov", "Quintero", "Rossi", "Santos", "Tanaka",
  "Ueda", "Varga", "Weber", "Xu", "Yamamoto", "Zielinski", "Alvarez", "Brennan", "Costa", "Delgado",
]);
export const PERSON_NAMES = Object.freeze(FIRST_NAMES.flatMap((first) => LAST_NAMES.map((last) => `${first} ${last}`)));
const CITIES = Object.freeze([
  "Lisbon", "Osaka", "Toronto", "Nairobi", "Denver", "Krakow", "Lyon", "Seoul", "Austin", "Dublin", "Porto",
  "Melbourne", "Bogota", "Tallinn", "Leeds", "Halifax", "Bergen", "Valencia", "Calgary", "Graz", "Accra",
  "Cebu", "Durban", "Malmo",
]);
const DEPARTMENTS = Object.freeze([
  "Engineering", "Marketing", "Sales", "Support", "Finance", "Legal", "Operations", "Research",
  "Human Resources", "Facilities", "Procurement", "Security", "Design", "Data Platform", "Customer Success",
  "Logistics", "Quality Assurance", "Training", "Compliance", "Partnerships", "Field Service", "Infrastructure",
  "Product Management", "Communications", "Internal Audit", "Treasury", "Payroll", "Analytics",
  "Developer Relations", "Localization", "Risk Management", "Workplace Services",
]);
const PRODUCT_ADJECTIVES = Object.freeze([
  "Compact", "Rugged", "Wireless", "Ergonomic", "Modular", "Portable", "Silent", "Solar", "Folding", "Heated",
  "Smart", "Steel",
]);
const PRODUCT_NOUNS = Object.freeze([
  "Desk Lamp", "Keyboard", "Monitor Arm", "Office Chair", "Label Printer", "Router", "Headset", "Webcam",
  "Standing Desk", "Paper Shredder", "Power Bank", "Projector",
]);
const COMPANY_PREFIXES = Object.freeze([
  "Northwind", "Bluepeak", "Copperleaf", "Driftwood", "Evergreen", "Foxglove", "Granite", "Hollowbrook",
  "Ironbridge", "Juniper", "Kestrel", "Lakeshore", "Moonstone", "Nettle", "Oakridge", "Pinecrest",
]);
const COMPANY_SUFFIXES = Object.freeze([
  "Logistics", "Analytics", "Systems", "Partners", "Consulting", "Services", "Labs", "Supply",
]);
const JOB_TITLES = Object.freeze([
  "Data Analyst", "Account Manager", "Software Engineer", "Payroll Specialist", "Recruiter", "Product Designer",
  "Support Lead", "Security Engineer", "Office Manager", "Financial Analyst", "Technical Writer",
  "Network Administrator", "Sales Associate", "Project Coordinator", "Legal Counsel", "QA Engineer",
]);
const MILESTONES = Object.freeze([
  "Design review", "Pilot launch", "Security audit", "Data migration", "User training", "Go-live",
  "Vendor selection", "Load testing", "Budget sign-off", "Contract signature",
]);
const STATUSES = Object.freeze(["On track", "At risk", "Delayed", "Complete"]);
const SERVICES = Object.freeze([
  "Cloud hosting", "Payroll processing", "Office cleaning", "Legal advice", "Translation", "Security monitoring",
  "Printing", "Catering", "Travel booking", "Recruiting", "Data backup", "Courier", "IT support",
  "Market research",
]);
const TERRITORIES = Object.freeze([
  "North Coast", "South Coast", "Lake District", "Highlands", "Riverlands", "Central Plains", "Eastern Hills",
  "Western Valley", "Bay Area", "Desert Region", "Mountain West", "Harbor District", "Capital Region",
  "Northern Islands", "Southern Islands", "Forest Belt", "Prairie Region", "Delta Region", "Canyon Region",
  "Metro North", "Metro South", "Upper Valley", "Lower Valley", "Coastal Plains",
]);
const PROJECT_NAMES = Object.freeze([
  "Atlas", "Beacon", "Cobalt", "Delta", "Ember", "Falcon", "Granite", "Harbor", "Iris", "Juniper", "Keystone",
  "Lumen", "Meridian", "Nimbus", "Orion", "Pioneer", "Quartz", "Redwood", "Summit", "Tidal", "Umber", "Vector",
  "Willow", "Zephyr", "Aurora", "Basalt", "Cascade", "Dune", "Echo", "Fjord", "Glacier", "Helix", "Indigo",
  "Jasper", "Kelp", "Lagoon",
]);

export const VENDOR_NAMES = Object.freeze(
  COMPANY_PREFIXES.flatMap((prefix) => COMPANY_SUFFIXES.map((suffix) => `${prefix} ${suffix}`))
);
export const PRODUCT_NAMES = Object.freeze(
  PRODUCT_ADJECTIVES.flatMap((adjective) => PRODUCT_NOUNS.map((noun) => `${adjective} ${noun}`))
);

// ---------------------------------------------------------------------------
// Cells: values and what Excel displays for them
// ---------------------------------------------------------------------------

export const SHEET_NUMBER_FORMATS = Object.freeze({
  count: "#,##0",
  date: "yyyy-mm-dd",
  money: "#,##0.00",
  number: "0",
  percent: "0.0%",
});

const groupThousands = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The text Excel shows for `value` under the column kind's number format. */
export const formatCellDisplay = (value, kind) => {
  switch (kind) {
    case "money": {
      const [whole, fraction] = Math.abs(value).toFixed(2).split(".");

      return `${value < 0 ? "-" : ""}${groupThousands(whole)}.${fraction}`;
    }
    case "count":
      return `${value < 0 ? "-" : ""}${groupThousands(String(Math.abs(Math.round(value))))}`;
    case "number":
      return String(Math.round(value));
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    default:
      return String(value);
  }
};

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** The Excel date serial of an ISO date (yyyy-mm-dd), in the 1900 date system. */
export const isoDateToExcelSerial = (isoDate) => {
  const [year, month, day] = isoDate.split("-").map(Number);

  return (Date.UTC(year, month - 1, day) - EXCEL_EPOCH_MS) / 86400000;
};

const isoDate = (milliseconds) => new Date(milliseconds).toISOString().slice(0, 10);

const randomIsoDate = (random, [start, end]) => {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);

  return isoDate(from + integerBetween(random, 0, Math.round((to - from) / 86400000)) * 86400000);
};

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

// Each domain: a key column and five typed columns. A column draws from a
// pool ("person" from PERSON_NAMES), a numeric range, or a date range.
export const SHEET_DOMAINS = Object.freeze([
  {
    columns: [
      { header: "Budget", kind: "money", range: [50000, 900000] },
      { header: "Spent", kind: "money", range: [10000, 950000] },
      { header: "Headcount", kind: "count", range: [3, 180] },
      { header: "Review date", kind: "date", range: ["2026-01-05", "2026-12-18"] },
      { header: "Owner", kind: "person" },
    ],
    id: "budget",
    key: { header: "Department", pool: DEPARTMENTS },
    rows: [12, 30],
    title: "Department budget",
  },
  {
    columns: [
      { header: "SKU", kind: "code", prefix: "SKU-" },
      { header: "Warehouse", kind: "choice", pool: CITIES },
      { header: "Quantity", kind: "count", range: [0, 12000] },
      { header: "Unit cost", kind: "money", range: [2, 1950] },
      { header: "Reorder date", kind: "date", range: ["2026-02-01", "2027-03-31"] },
    ],
    id: "inventory",
    key: { header: "Product", pool: PRODUCT_NAMES },
    rows: [20, 60],
    title: "Product inventory",
  },
  {
    columns: [
      { header: "Role", kind: "choice", pool: JOB_TITLES },
      { header: "Office", kind: "choice", pool: CITIES },
      { header: "Start date", kind: "date", range: ["2015-03-02", "2026-10-30"] },
      { header: "Manager", kind: "person" },
      { header: "Extension", kind: "number", range: [1000, 9999] },
    ],
    id: "staff",
    key: { header: "Employee", pool: PERSON_NAMES },
    rows: [20, 60],
    title: "Staff directory",
  },
  {
    columns: [
      { header: "Q1 revenue", kind: "money", range: [80000, 2400000] },
      { header: "Q2 revenue", kind: "money", range: [80000, 2400000] },
      { header: "Q3 revenue", kind: "money", range: [80000, 2400000] },
      { header: "Q4 revenue", kind: "money", range: [80000, 2400000] },
      { header: "Growth", kind: "percent", range: [-0.15, 0.4] },
    ],
    id: "sales",
    key: { header: "Territory", pool: TERRITORIES },
    rows: [12, 24],
    title: "Regional sales",
  },
  {
    columns: [
      { header: "Milestone", kind: "choice", pool: MILESTONES },
      { header: "Owner", kind: "person" },
      { header: "Due date", kind: "date", range: ["2026-01-12", "2027-06-30"] },
      { header: "Budget", kind: "money", range: [15000, 750000] },
      { header: "Status", kind: "choice", pool: STATUSES },
    ],
    id: "projects",
    key: { header: "Project", pool: PROJECT_NAMES.map((name) => `Project ${name}`) },
    rows: [12, 36],
    title: "Project milestones",
  },
  {
    columns: [
      { header: "Service", kind: "choice", pool: SERVICES },
      { header: "Annual fee", kind: "money", range: [1200, 480000] },
      { header: "Renewal date", kind: "date", range: ["2026-01-15", "2028-12-15"] },
      { header: "Contact", kind: "person" },
      { header: "Contract years", kind: "count", range: [1, 5] },
    ],
    id: "vendors",
    key: { header: "Vendor", pool: VENDOR_NAMES },
    rows: [15, 50],
    title: "Vendor contracts",
  },
]);

const cellValue = (random, column, draws) => {
  switch (column.kind) {
    case "money":
      return integerBetween(random, column.range[0] * 100, column.range[1] * 100) / 100;
    case "count":
    case "number":
      return integerBetween(random, column.range[0], column.range[1]);
    case "percent":
      return integerBetween(random, Math.round(column.range[0] * 1000), Math.round(column.range[1] * 1000)) / 1000;
    case "date":
      return randomIsoDate(random, column.range);
    case "person":
      return draws.person();
    case "code":
      return `${column.prefix}${draws.code()}`;
    case "choice":
      return column.pool[Math.floor(random() * column.pool.length)];
    default:
      throw new Error(`Unknown column kind ${column.kind}.`);
  }
};

/**
 * One workbook's content: the domain's key column and typed columns, a random
 * number of rows within the domain's range, every cell with its value and the
 * text Excel displays for it.
 */
export const buildSheetSpec = ({ domain, id, random }) => {
  const rowCount = Math.min(integerBetween(random, domain.rows[0], domain.rows[1]), domain.key.pool.length);
  const keys = shuffled(random, domain.key.pool).slice(0, rowCount);
  const usedNames = new Set(domain.key.pool === PERSON_NAMES ? keys : []);
  const draws = {
    code: createDrawer(
      random,
      Array.from({ length: 9000 }, (_, index) => String(index + 1000)),
      "codes"
    ),
    person: createDrawer(
      random,
      PERSON_NAMES.filter((name) => !usedNames.has(name)),
      "person names"
    ),
  };

  return {
    columns: domain.columns.map(({ header, kind }) => ({ header, kind })),
    domain: domain.id,
    id,
    keyHeader: domain.key.header,
    rows: keys.map((key) => ({
      cells: domain.columns.map((column) => {
        const value = cellValue(random, column, draws);

        return { display: column.kind === "date" ? value : formatCellDisplay(value, column.kind), value };
      }),
      key,
    })),
    sheetName: domain.title,
    title: domain.title,
  };
};

const NUMERIC_KINDS = new Set(["money", "count", "number", "percent"]);

/** `count` lookup questions of distinct cells; the gold answer is the cell's displayed text. */
export const buildSheetQuestions = ({ count, random, spec }) => {
  const cells = shuffled(
    random,
    spec.rows.flatMap((row, rowIndex) => spec.columns.map((column, columnIndex) => ({ columnIndex, rowIndex })))
  );
  const usedRows = new Set();
  const questions = [];

  for (const { columnIndex, rowIndex } of cells) {
    if (questions.length >= count) {
      break;
    }

    // One question per row, so no two questions share their evidence row.
    if (usedRows.has(rowIndex)) {
      continue;
    }

    const row = spec.rows[rowIndex];
    const column = spec.columns[columnIndex];
    const cell = row.cells[columnIndex];

    usedRows.add(rowIndex);
    questions.push({
      corpus: "sheet",
      docId: spec.id,
      evidence: { key: row.key, value: cell.display },
      gold: {
        kind: column.kind === "date" ? "date" : NUMERIC_KINDS.has(column.kind) ? "number" : "text",
        value: cell.display,
      },
      group: column.kind === "person" ? "person" : NUMERIC_KINDS.has(column.kind) ? "number" : column.kind,
      id: `${spec.id}-q${questions.length + 1}`,
      question: `${column.kind === "person" ? "Who" : "What"} is the ${column.header} for ${row.key}?`,
    });
  }

  return questions;
};

/** The workbook as rows of cells for a writer: the header, then each row (numbers as numbers, dates as Excel serials). */
export const sheetSpecToCells = (spec) => [
  [spec.keyHeader, ...spec.columns.map((column) => column.header)].map((text) => ({ type: "string", value: text })),
  ...spec.rows.map((row) => [
    { type: "string", value: row.key },
    ...row.cells.map((cell, index) => {
      const { kind } = spec.columns[index];

      if (kind === "date") {
        return { format: SHEET_NUMBER_FORMATS.date, type: "number", value: isoDateToExcelSerial(cell.value) };
      }

      return NUMERIC_KINDS.has(kind)
        ? { format: SHEET_NUMBER_FORMATS[kind], type: "number", value: cell.value }
        : { type: "string", value: cell.value };
    }),
  ]),
];

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

const MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December",
]);
const PERIODS = Object.freeze(["the first quarter", "the second quarter", "the third quarter", "the fourth quarter"]);
const METRICS = Object.freeze([
  "Customer churn", "Support tickets", "Website traffic", "Mobile signups", "Phishing reports", "Cloud spend",
  "Return requests", "Trial conversions", "Average order value", "Employee turnover", "Late deliveries",
  "App crashes",
]);
const SYSTEMS = Object.freeze([
  "payroll", "CRM", "email", "VPN", "data warehouse", "ticketing", "ERP", "backup", "identity", "billing",
]);
const CHANNELS = Object.freeze(["live chat", "email support", "phone support", "the partner portal", "social media"]);
const STREETS = Object.freeze([
  "Harbor Street", "King Street", "Maple Avenue", "Station Road", "Elm Street", "Market Square", "River Lane",
  "Oak Boulevard", "Hill Road", "Park Avenue",
]);
const DECK_PRODUCTS = Object.freeze([
  "Nova app", "Pulse tracker", "Orbit dashboard", "Spark kit", "Atlas reader", "Echo speaker", "Vista monitor",
  "Flux router",
]);
const ONLINE_SERVICES = Object.freeze([
  "the payments API", "the customer portal", "the mobile app", "the search service", "the reporting site",
  "the login service",
]);
const EVENTS = Object.freeze([
  "annual partner summit", "spring hackathon", "customer advisory board", "leadership offsite", "sales kickoff",
]);
const REGIONS = Object.freeze(["Nordic", "Benelux", "Andean", "Gulf", "Baltic", "Iberian", "Alpine", "Caribbean"]);
const TOPICS = Object.freeze(["onboarding", "pricing", "accessibility", "remote work", "procurement", "travel"]);
const DECK_TITLES = Object.freeze([
  "Quarterly Business Review", "Security Program Update", "Customer Support Review", "Product Launch Plan",
  "IT Operations Review", "People and Culture Update", "Sales Kickoff Briefing", "Infrastructure Roadmap",
  "Finance Committee Briefing", "Partner Program Review",
]);
const SLIDE_TITLES = Object.freeze([
  "Highlights", "Results", "Operations", "Customers", "People", "Risks", "Next Steps", "Budget", "Roadmap",
  "Partners",
]);
const TEAMS = Object.freeze(["Operations team", "Strategy office", "Program office", "Leadership team"]);

// Each template takes its slots from the deck's drawers (no two facts of a
// deck share a subject) and returns the bullet or note, the question and the
// gold answer.
const BODY_FACTS = Object.freeze([
  (d, random) => {
    const metric = d.metric();
    const period = d.period();
    const rose = random() < 0.5;
    const percent = integerBetween(random, 3, 48);

    return {
      gold: { kind: "number", value: `${percent} percent` },
      question: `By how many percent did ${metric.toLowerCase()} ${rose ? "rise" : "fall"} in ${period}?`,
      statement: `${metric} ${rose ? "rose" : "fell"} ${percent} percent in ${period}`,
    };
  },
  (d) => {
    const person = d.person();
    const project = d.project();

    return {
      gold: { kind: "text", value: person },
      question: `Who leads the ${project} rollout?`,
      statement: `${person} leads the ${project} rollout`,
    };
  },
  (d, random) => {
    const system = d.system();
    const when = `${MONTHS[integerBetween(random, 0, 11)]} ${integerBetween(random, 2026, 2027)}`;

    return {
      gold: { kind: "text", value: when },
      question: `When is the ${system} upgrade scheduled?`,
      statement: `The ${system} upgrade is scheduled for ${when}`,
    };
  },
  (d, random) => {
    const region = d.region();
    const period = d.period();
    const deals = integerBetween(random, 7, 240);

    return {
      gold: { kind: "number", value: String(deals) },
      question: `How many deals did the ${region} team close in ${period}?`,
      statement: `The ${region} team closed ${deals} deals in ${period}`,
    };
  },
  (d, random) => {
    const channel = d.channel();
    const minutes = integerBetween(random, 2, 95);

    return {
      gold: { kind: "number", value: `${minutes} minutes` },
      question: `What is the average response time for ${channel}?`,
      statement: `Average response time for ${channel} is ${minutes} minutes`,
    };
  },
  (d, random) => {
    const city = d.city();
    const street = d.street();

    return {
      gold: { kind: "text", value: street },
      question: `Where does the ${city} office move to?`,
      statement: `The ${city} office moves to ${street} in ${MONTHS[integerBetween(random, 0, 11)]}`,
    };
  },
  (d, random) => {
    const vendor = d.vendor();
    const years = integerBetween(random, 2, 7);

    return {
      gold: { kind: "number", value: `${years} years` },
      question: `For how many years did ${vendor} renew its contract?`,
      statement: `${vendor} renewed its contract for ${years} years`,
    };
  },
  (d, random) => {
    const product = d.product();
    const countries = integerBetween(random, 3, 41);

    return {
      gold: { kind: "number", value: String(countries) },
      question: `In how many countries does the ${product} launch?`,
      statement: `The ${product} launches in ${countries} countries`,
    };
  },
  (d, random) => {
    const service = d.service();
    const uptime = (integerBetween(random, 9500, 9999) / 100).toFixed(2);

    return {
      gold: { kind: "number", value: `${uptime} percent` },
      question: `What uptime did ${service} reach?`,
      statement: `Uptime for ${service} reached ${uptime} percent`,
    };
  },
  (d) => {
    const event = d.event();
    const city = d.city();

    return {
      gold: { kind: "text", value: city },
      question: `Where does the ${event} take place?`,
      statement: `The ${event} takes place in ${city}`,
    };
  },
  (d, random) => {
    const department = d.department();
    const period = d.period();
    const hires = integerBetween(random, 2, 64);

    return {
      gold: { kind: "number", value: String(hires) },
      question: `How many people did ${department} hire in ${period}?`,
      statement: `${department} hired ${hires} people in ${period}`,
    };
  },
  (d, random) => {
    const product = d.product();
    const score = (integerBetween(random, 25, 49) / 10).toFixed(1);

    return {
      gold: { kind: "number", value: `${score} out of 5` },
      question: `What is the customer satisfaction score for the ${product}?`,
      statement: `Customer satisfaction for the ${product} is ${score} out of 5`,
    };
  },
]);

const NOTE_FACTS = Object.freeze([
  (d) => {
    const person = d.person();
    const topic = d.topic();

    return {
      gold: { kind: "text", value: person },
      question: `Who owns the ${topic} follow-up?`,
      statement: `Remind the team that ${person} owns the ${topic} follow-up.`,
    };
  },
  (d, random) => {
    const topic = d.topic();
    const responses = integerBetween(random, 40, 2600);

    return {
      gold: { kind: "number", value: String(responses) },
      question: `How many responses did the ${topic} survey receive?`,
      statement: `The ${topic} survey received ${responses} responses.`,
    };
  },
  (d, random) => {
    const project = d.project();
    const when = `${MONTHS[integerBetween(random, 0, 11)]} ${integerBetween(random, 2, 28)}`;

    return {
      gold: { kind: "text", value: when },
      question: `When is budget approval for ${project} expected?`,
      statement: `Budget approval for ${project} is expected on ${when}.`,
    };
  },
  (d, random) => {
    const vendor = d.vendor();
    const discount = integerBetween(random, 4, 30);

    return {
      gold: { kind: "number", value: `${discount} percent` },
      question: `What discount did ${vendor} offer?`,
      statement: `${vendor} offered a ${discount} percent discount.`,
    };
  },
  (d, random) => {
    const city = d.city();
    const month = MONTHS[integerBetween(random, 0, 11)];

    return {
      gold: { kind: "text", value: month },
      question: `When does the pilot in ${city} start?`,
      statement: `Mention that the pilot in ${city} starts in ${month}.`,
    };
  },
]);

const createDeckDrawers = (random) => ({
  channel: createDrawer(random, CHANNELS, "channels"),
  city: createDrawer(random, CITIES, "cities"),
  department: createDrawer(random, DEPARTMENTS, "departments"),
  event: createDrawer(random, EVENTS, "events"),
  metric: createDrawer(random, METRICS, "metrics"),
  period: createDrawer(random, PERIODS, "periods"),
  person: createDrawer(random, PERSON_NAMES, "person names"),
  product: createDrawer(random, DECK_PRODUCTS, "products"),
  project: createDrawer(
    random,
    PROJECT_NAMES.map((name) => `Project ${name}`),
    "projects"
  ),
  region: createDrawer(random, REGIONS, "regions"),
  service: createDrawer(random, ONLINE_SERVICES, "services"),
  street: createDrawer(random, STREETS, "streets"),
  system: createDrawer(random, SYSTEMS, "systems"),
  topic: createDrawer(random, TOPICS, "topics"),
  vendor: createDrawer(random, VENDOR_NAMES, "vendors"),
});

/**
 * One deck: a title slide and four content slides of three fact bullets;
 * two content slides carry one more fact in their speaker notes. Facts use
 * distinct templates and subjects within the deck, so each question has one
 * answer. Periods are drawn without replacement, so at most four facts use one.
 */
export const buildDeckSpec = ({ id, random }) => {
  const drawers = createDeckDrawers(random);
  const bodyTemplates = shuffled(random, BODY_FACTS.map((template, index) => ({ index, template })));
  const noteTemplates = shuffled(random, NOTE_FACTS.map((template, index) => ({ index, template })));
  const titles = shuffled(random, SLIDE_TITLES).slice(0, 4);
  const noteSlides = new Set(shuffled(random, [0, 1, 2, 3]).slice(0, 2));
  let bodyCursor = 0;
  let noteCursor = 0;
  const factOf = ({ index, template }, kind) => ({ ...template(drawers, random), kind, template: index });
  const slides = titles.map((title, slideIndex) => {
    const bullets = Array.from({ length: 3 }, () => factOf(bodyTemplates[bodyCursor++], "body"));
    const note = noteSlides.has(slideIndex) ? factOf(noteTemplates[noteCursor++], "notes") : null;

    return { bullets, note, title };
  });

  return {
    id,
    slides,
    subtitle: `${TEAMS[Math.floor(random() * TEAMS.length)]}, ${2026}`,
    title: DECK_TITLES[Math.floor(random() * DECK_TITLES.length)],
  };
};

/** Four questions about bullets (one per content slide) and one per speaker note. */
export const buildDeckQuestions = ({ random, spec }) => {
  const questions = [];

  spec.slides.forEach((slide, slideIndex) => {
    const fact = slide.bullets[Math.floor(random() * slide.bullets.length)];

    questions.push({ fact, slideIndex });

    if (slide.note) {
      questions.push({ fact: slide.note, slideIndex });
    }
  });

  return questions.map(({ fact, slideIndex }, index) => ({
    corpus: "deck",
    docId: spec.id,
    evidence: { statement: fact.statement },
    gold: fact.gold,
    group: fact.kind,
    id: `${spec.id}-q${index + 1}`,
    question: fact.question,
    slide: slideIndex + 2,
  }));
};

// ---------------------------------------------------------------------------
// Word documents from QASPER
// ---------------------------------------------------------------------------

const FLOAT_EVIDENCE = /^FLOAT SELECTED/;

export const isAnswerableQasperQuestion = (qa) => !(qa.answers ?? []).every((entry) => entry.answer?.unanswerable);

/** Answerable, and no annotator's evidence is a table or figure (a Word document made from the paper's text has none). */
export const isTextEvidenceQasperQuestion = (qa) =>
  isAnswerableQasperQuestion(qa) &&
  !(qa.answers ?? []).some((entry) => (entry.answer?.evidence ?? []).some((evidence) => FLOAT_EVIDENCE.test(String(evidence))));

/** `count` papers, seeded, among those with at least `minQuestions` text-evidence questions. */
export const selectQasperPapers = (qasper, { count, minQuestions = 3, seed = 1 }) => {
  const candidates = Object.keys(qasper)
    .sort()
    .filter((paperId) => (qasper[paperId].qas ?? []).filter(isTextEvidenceQasperQuestion).length >= minQuestions);

  return shuffled(createSeededRandom(seed), candidates).slice(0, count).sort();
};

const cleanText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * The paper as Word blocks: its title as a plain paragraph, then "Abstract"
 * and every top-level section as a Heading 1 and every deeper section
 * ("Model ::: Encoder") as a Heading 2 named by its last part, each followed
 * by its paragraphs.
 */
export const qasperPaperToBlocks = (paper) => {
  const blocks = [{ text: cleanText(paper.title) }];

  if (cleanText(paper.abstract)) {
    blocks.push({ heading: 1, text: "Abstract" }, { text: cleanText(paper.abstract) });
  }

  for (const section of paper.full_text ?? []) {
    const parts = String(section.section_name ?? "")
      .split(":::")
      .map(cleanText)
      .filter(Boolean);

    if (parts.length > 0) {
      blocks.push({ heading: Math.min(parts.length, 2), text: parts[parts.length - 1] });
    }

    for (const paragraph of section.paragraphs ?? []) {
      if (cleanText(paragraph)) {
        blocks.push({ text: cleanText(paragraph) });
      }
    }
  }

  return blocks;
};

/** The paper's text-evidence questions, with every annotator's reference answer and extractive spans. */
export const buildWordQuestions = ({ paper, paperId }) =>
  (paper.qas ?? []).filter(isTextEvidenceQasperQuestion).map((qa) => ({
    corpus: "word",
    docId: paperId,
    gold: {
      kind: "qasper",
      references: (qa.answers ?? []).map((entry) => describeQasperAnswer(entry.answer)?.text).filter(Boolean),
      spans: (qa.answers ?? []).flatMap((entry) => entry.answer?.extractive_spans ?? []).filter(Boolean),
    },
    group: "text",
    id: qa.question_id,
    question: cleanText(qa.question),
  }));

// ---------------------------------------------------------------------------
// AppleScript
// ---------------------------------------------------------------------------

/** An AppleScript string literal. */
export const appleScriptString = (text) => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const appleScriptLines = (lines) => lines.map(appleScriptString).join(" & return & ");

/** A script that makes the deck in PowerPoint and saves it as .pptx and .pdf (paths are POSIX). */
export const deckAppleScript = ({ pdfPath, pptxPath, spec }) =>
  [
    "with timeout of 900 seconds",
    'tell application "Microsoft PowerPoint"',
    "set pres to make new presentation",
    "set s to make new slide at end of pres with properties {layout:slide layout title slide}",
    `set content of text range of text frame of place holder 1 of s to ${appleScriptString(spec.title)}`,
    `set content of text range of text frame of place holder 2 of s to ${appleScriptString(spec.subtitle)}`,
    ...spec.slides.flatMap((slide) => [
      "set s to make new slide at end of pres with properties {layout:slide layout text slide}",
      `set content of text range of text frame of place holder 1 of s to ${appleScriptString(slide.title)}`,
      `set content of text range of text frame of place holder 2 of s to ${appleScriptLines(
        slide.bullets.map((fact) => fact.statement)
      )}`,
      ...(slide.note
        ? [`set content of text range of text frame of place holder 2 of notes page of s to ${appleScriptString(slide.note.statement)}`]
        : []),
    ]),
    `save pres in (POSIX file ${appleScriptString(pptxPath)}) as save as Open XML presentation`,
    "set pres to active presentation",
    `save pres in (POSIX file ${appleScriptString(pdfPath)}) as save as PDF`,
    "close active presentation saving no",
    "end tell",
    "end timeout",
  ].join("\n");

/** A script that opens a document in Word and saves it again as .docx and .pdf. */
export const wordRoundTripAppleScript = ({ docxPath, pdfPath, sourcePath }) =>
  [
    "with timeout of 900 seconds",
    'tell application "Microsoft Word"',
    `open (POSIX file ${appleScriptString(sourcePath)})`,
    `save as active document file name ${appleScriptString(docxPath)} file format format document`,
    `save as active document file name ${appleScriptString(pdfPath)} file format format PDF`,
    "close active document saving no",
    "end tell",
    "end timeout",
  ].join("\n");

/**
 * A script that opens a workbook in Excel, fits its columns, prints the
 * header row on every page and scales the sheet to one page wide (the PDF a
 * careful user exports), then saves it as .xlsx and .pdf.
 */
export const sheetRoundTripAppleScript = ({ pdfPath, sourcePath, xlsxPath }) =>
  [
    "with timeout of 900 seconds",
    'tell application "Microsoft Excel"',
    `open workbook workbook file name ${appleScriptString(sourcePath)}`,
    "set wb to active workbook",
    "set ws to worksheet 1 of wb",
    "autofit (entire column of (used range of ws))",
    "set ps to page setup object of ws",
    'set print title rows of ps to "$1:$1"',
    "set zoom of ps to false",
    "set fit to pages wide of ps to 1",
    "set fit to pages tall of ps to 10",
    `save workbook as wb filename ${appleScriptString(xlsxPath)} file format workbook normal file format`,
    `save workbook as active workbook filename ${appleScriptString(pdfPath)} file format PDF file format`,
    "close active workbook saving no",
    "end tell",
    "end timeout",
  ].join("\n");

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const normalizeAnswerText = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Every number written in `text`, thousands separators dropped ("-2,250.00"
 * is -2250). Digits glued to a letter are part of a name, not a number: the
 * 3 of "Q3 revenue" is not a value.
 */
export const extractNumbers = (text) =>
  [...normalizeAnswerText(text).matchAll(/(?<!\p{L})-?\d[\d,]*(?:\.\d+)?/gu)]
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter(Number.isFinite);

// The answer writer labels nearly every sentence "[Source N]", and an ISO date
// splits into numbers (2026, -10, -25); neither is the number an answer gives.
const withoutSourceLabelsAndDates = (text) =>
  String(text ?? "")
    .replace(/\[\s*source[^\]]*\]/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");

const MONTH_NUMBERS = new Map(MONTHS.map((month, index) => [month.toLowerCase(), index + 1]));

/** The ISO dates `text` writes: yyyy-mm-dd, "September 14, 2026", "14 September 2026". */
export const extractIsoDates = (text) => {
  const normalized = normalizeAnswerText(text);
  const dates = [...normalized.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map((match) => match[0]);
  const pad = (value) => String(value).padStart(2, "0");

  for (const match of normalized.matchAll(/\b([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/g)) {
    if (MONTH_NUMBERS.has(match[1])) {
      dates.push(`${match[3]}-${pad(MONTH_NUMBERS.get(match[1]))}-${pad(match[2])}`);
    }
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)? ([a-z]+),? (\d{4})\b/g)) {
    if (MONTH_NUMBERS.has(match[2])) {
      dates.push(`${match[3]}-${pad(MONTH_NUMBERS.get(match[2]))}-${pad(match[1])}`);
    }
  }

  return dates;
};

const wordBounded = (text) => ` ${normalizeAnswerText(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * Whether an answer gives the gold value. A number counts when the answer
 * writes the same number (thousands separators and units aside: "47,250.00"
 * and "47250", "12.5%" and "12.5 percent"); a date when it writes the same
 * day; text when the gold words appear in order as whole words. An
 * abstention never counts.
 */
export const answerMatchesGold = ({ abstained, text }, gold) => {
  if (abstained || !String(text ?? "").trim()) {
    return false;
  }

  if (gold.kind === "number") {
    const [expected] = extractNumbers(gold.value);

    return extractNumbers(withoutSourceLabelsAndDates(text)).some((value) => Math.abs(value - expected) < 1e-9);
  }

  if (gold.kind === "date") {
    return extractIsoDates(text).includes(gold.value);
  }

  return wordBounded(text).includes(wordBounded(gold.value));
};

const evidenceText = (text) => normalizeAnswerText(String(text ?? "").replace(/[•▪●•]/g, " "));

/** Whether one retrieved chunk holds the evidence row (its key and the gold value) or the fact sentence. */
export const evidenceInContexts = (contexts, question) => {
  const chunks = contexts.map(evidenceText);

  if (question.corpus === "sheet") {
    const key = evidenceText(question.evidence.key);
    const value = evidenceText(question.evidence.value);

    return chunks.some((chunk) => chunk.includes(key) && chunk.includes(value));
  }

  if (question.corpus === "deck") {
    const statement = evidenceText(question.evidence.statement).replace(/[.]$/, "");

    return chunks.some((chunk) => chunk.includes(statement));
  }

  const spans = question.gold.spans ?? [];

  if (spans.length === 0) {
    return null;
  }

  const haystack = ` ${normalizeQasperAnswer(chunks.join("\n"))} `;

  return spans.some((span) => {
    // Folded like the chunks (NFKC, typographic quotes and dashes), or a span
    // with curly quotes would not even match its own paragraph.
    const needle = normalizeQasperAnswer(evidenceText(span));

    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
};

/** One arm's outcome for one question. */
export const scoreArmAnswer = ({ abstained, contexts, question, text }) => {
  const base = {
    abstained: Boolean(abstained),
    evidence: evidenceInContexts(contexts, question),
  };

  if (question.corpus === "word") {
    // An abstention scores 0, as the rules declare. The official evaluator
    // would score it as the answer "Unanswerable", which earns 1 whenever one
    // annotator marked the question unanswerable.
    return {
      ...base,
      f1: abstained
        ? 0
        : Number(qasperAnswerF1(toQasperPrediction({ abstained: false, text }), question.gold.references).toFixed(4)),
    };
  }

  return { ...base, correct: answerMatchesGold({ abstained, text }, question.gold) };
};

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export const CORPUS_METRICS = Object.freeze({
  deck: ["correct", "evidence", "answered"],
  sheet: ["correct", "evidence", "answered"],
  word: ["f1", "evidence", "answered"],
});

const metricValue = (arm, metric) => {
  if (metric === "answered") {
    return arm.abstained ? 0 : 1;
  }

  const value = arm[metric];

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "boolean" ? (value ? 1 : 0) : value;
};

const mean = (values) => (values.length === 0 ? null : roundTo4(values.reduce((sum, value) => sum + value, 0) / values.length));

/**
 * Native minus PDF over the rows that scored the metric in both arms: the
 * mean difference, a question-level bootstrap interval, and an interval that
 * resamples whole documents (the questions of one document share its chunks).
 */
export const pairedArmDelta = (rows, metric, { iterations = 10000, seed = 1 } = {}) => {
  const pairs = rows
    .map((row) => ({ docId: row.docId, native: metricValue(row.native, metric), pdf: metricValue(row.pdf, metric) }))
    .filter((pair) => pair.native !== null && pair.pdf !== null);
  const diffs = pairs.map((pair) => pair.native - pair.pdf);

  if (diffs.length === 0) {
    return { ci95: null, ci95ByDocument: null, delta: null, flips: { lost: 0, won: 0 }, native: null, pdf: null, questions: 0 };
  }

  const byDocument = new Map();

  for (const pair of pairs) {
    byDocument.set(pair.docId, [...(byDocument.get(pair.docId) ?? []), pair.native - pair.pdf]);
  }

  return {
    ci95: bootstrapMeanInterval(diffs, { iterations, random: createSeededRandom(seed) }),
    ci95ByDocument: bootstrapClusterMeanInterval([...byDocument.values()], {
      iterations,
      random: createSeededRandom(seed + 1),
    }),
    delta: mean(diffs),
    documents: byDocument.size,
    flips: {
      lost: diffs.filter((diff) => diff < 0).length,
      won: diffs.filter((diff) => diff > 0).length,
    },
    native: mean(pairs.map((pair) => pair.native)),
    pdf: mean(pairs.map((pair) => pair.pdf)),
    questions: diffs.length,
  };
};

/** The native arm alone (notes questions, which a PDF export cannot answer). */
export const summarizeNativeOnly = (rows, metrics) =>
  Object.fromEntries(
    metrics.map((metric) => {
      const values = rows.map((row) => metricValue(row.native, metric)).filter((value) => value !== null);

      return [metric, { native: mean(values), pdfPresent: false, questions: values.length }];
    })
  );

/** Per corpus and group: the paired deltas, or for notes the native arm alone. */
export const summarizeOfficeFormatRows = (rows, options = {}) => {
  const summary = {};

  for (const corpus of OFFICE_FORMAT_CORPORA) {
    const corpusRows = rows.filter((row) => row.corpus === corpus);

    if (corpusRows.length === 0) {
      continue;
    }

    const metrics = CORPUS_METRICS[corpus];
    const paired = corpusRows.filter((row) => row.group !== "notes");
    const notes = corpusRows.filter((row) => row.group === "notes");
    const groups = [...new Set(paired.map((row) => row.group))].sort();

    summary[corpus] = {
      documents: new Set(corpusRows.map((row) => row.docId)).size,
      groups: Object.fromEntries(
        groups.map((group) => [
          group,
          Object.fromEntries(
            metrics.map((metric) => [
              metric,
              pairedArmDelta(
                paired.filter((row) => row.group === group),
                metric,
                options
              ),
            ])
          ),
        ])
      ),
      paired: Object.fromEntries(metrics.map((metric) => [metric, pairedArmDelta(paired, metric, options)])),
      ...(notes.length > 0 ? { notesNativeOnly: summarizeNativeOnly(notes, metrics) } : {}),
      questions: corpusRows.length,
    };
  }

  return summary;
};

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const formatNumber = (value) => (value === null || value === undefined ? "—" : value.toFixed(3));
const formatSigned = (value) =>
  value === null || value === undefined ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}`;
const formatInterval = (interval) =>
  interval ? `[${formatSigned(interval[0])}, ${formatSigned(interval[1])}]` : "—";

const METRIC_LABELS = Object.freeze({
  answered: "answered (not abstained)",
  correct: "answer gives the gold value",
  evidence: "evidence in the model's context",
  f1: "QASPER answer F1 (abstention = 0)",
});

export const formatOfficeFormatMarkdown = (report) => {
  const lines = [
    "# Office files against Office's own PDF export",
    "",
    `Generated ${report.generatedAt}. Chat model ${report.config.chatModel ?? "?"}, embeddings ${
      report.config.embeddingModel ?? "?"
    }. Native minus PDF; 95% intervals by question and by document (${report.config.iterations} resamples).`,
    "",
  ];

  for (const [corpus, summary] of Object.entries(report.summary)) {
    lines.push(`## ${corpus} (${summary.documents} documents, ${summary.questions} questions)`, "");
    lines.push("| group | metric | n | native | PDF | native − PDF | CI by question | CI by document | +/− |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

    const entries = [["all", summary.paired], ...Object.entries(summary.groups)];

    for (const [group, metrics] of entries) {
      for (const [metric, delta] of Object.entries(metrics)) {
        lines.push(
          `| ${group} | ${METRIC_LABELS[metric] ?? metric} | ${delta.questions} | ${formatNumber(delta.native)} | ${formatNumber(
            delta.pdf
          )} | ${formatSigned(delta.delta)} | ${formatInterval(delta.ci95)} | ${formatInterval(delta.ci95ByDocument)} | +${
            delta.flips?.won ?? 0
          } / −${delta.flips?.lost ?? 0} |`
        );
      }
    }

    if (summary.notesNativeOnly) {
      lines.push("", "Speaker-notes questions (the PDF export has no notes, native arm only):", "");
      for (const [metric, value] of Object.entries(summary.notesNativeOnly)) {
        lines.push(`- ${METRIC_LABELS[metric] ?? metric}: ${formatNumber(value.native)} (n = ${value.questions})`);
      }
    }

    lines.push("");
  }

  if ((report.failures ?? []).length > 0) {
    lines.push("## Failures", "", ...report.failures.map((failure) => `- ${failure.docId} (${failure.arm}): ${failure.reason}`), "");
  }

  return lines.join("\n");
};
