export const CHECKABLE_CITATION_FIELDS = [
  "evidenceText",
  "excerpt",
  "text",
  "pageContent",
  "content",
];

export const SOURCE_LABEL_PATTERN = /\[(?:source|来源)\s*\d+\]/gi;
export const SOURCE_LABEL_CAPTURE_PATTERN = /\[(?:source|来源)\s*(\d+)\]/gi;
export const GROUPED_SOURCE_LABEL_PATTERN =
  /\[(?:(?:source|来源)\s*\d+\s*){2,}\]/gi;
export const NUMBER_PATTERN =
  /(?<![\w.+-])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?(?![\w%]|\.\d)/g;
export const NUMERIC_CONSTRAINT_PATTERNS = [
  /\b(?:at\s+least|at\s+or\s+above|greater\s+than\s+or\s+equal\s+to|higher\s+than\s+or\s+equal\s+to|minimum(?:\s+of)?|no\s+fewer\s+than|up\s+to|at\s+most|at\s+or\s+below|less\s+than\s+or\s+equal\s+to|lower\s+than\s+or\s+equal\s+to|maximum(?:\s+of)?|no\s+more\s+than|limit\s+of|limited\s+to|capped\s+at|within|more\s+than|greater\s+than|higher\s+than|over|above|exceeding|less\s+than|fewer\s+than|lower\s+than|under|below)\s+(?:about|approx(?:imately)?(?:\s+equal\s+to)?|around|ca\.?|circa|close\s+to|near|roughly)\s+[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /\b(?:at\s+least|at\s+or\s+above|greater\s+than\s+or\s+equal\s+to|higher\s+than\s+or\s+equal\s+to|minimum(?:\s+of)?|no\s+fewer\s+than|up\s+to|at\s+most|at\s+or\s+below|less\s+than\s+or\s+equal\s+to|lower\s+than\s+or\s+equal\s+to|maximum(?:\s+of)?|no\s+more\s+than|limit\s+of|limited\s+to|capped\s+at|within|more\s+than|greater\s+than|higher\s+than|over|above|exceeding|less\s+than|fewer\s+than|lower\s+than|under|below)\s+[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /\b(?:only|just|exactly|equal\s+to)\s+[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /(?:\b(?:about|approx(?:imately)?(?:\s+equal\s+to)?|around|ca\.?|circa|close\s+to|near|nearly|almost|roughly)\s+|[~≈]\s*)[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /(?:<=|>=|[<>=≤≥≦≧])\s*[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /±\s*[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /\b(?:except(?:ing)?|excluding|outside(?:\s+of)?)\s+(?:(?:between|from)\s+)?[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s*(?:[-–—]|and|through|to)\s*[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /\b(?:between|from)\s+[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s+(?:and|through|to)\s+[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /(?<![\w.+-])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s*(?:[-–—]|to|through)\s*[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?(?![\w%]|\.\d)/gi,
  /(?<![\w.])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s*(?:\+|(?:[a-z]+\s+){0,3}(?:or|and)\s+(?:above|below|more|fewer|greater|higher|less|lower|longer|over))(?!\d)/gi,
  /(?<![\w.])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s+(?:[a-z]+\s+){0,3}(?:at\s+least|at\s+most|no\s+(?:fewer|more)\s+than)\b/gi,
  /(?<![\w.])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s+(?:[a-z]+\s+){0,3}(?:about|approx(?:imately)?|around|circa|nearly|roughly)\b/gi,
  /(?<![\w.])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s+(?:[a-z]+\s+){1,3}(?:only|just)\b(?=\s*(?:[.!?。！？,;，；]|$))/gi,
  /(?<![\w.])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s+(?:[a-z]+\s+){0,3}(?:max(?:imum)?|tops?|minimum|min)\b/gi,
  /(?:最多|至多|不超过|至少|不少于|少于|低于|超过|高于|恰好|仅)(?:允许|可以|为|是)?\s*[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /(?:最多|至多|不超过|至少|不少于|少于|低于|超过|高于)(?:允许|可以|为|是)?\s*(?:约|大约|大概|近)(?:为|是)?\s*[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /(?:约|大约|大概|近)(?:为|是)?\s*[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /(?<![\w.])[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s*(?:个?工作日|天|日|周|月|年|小时|分钟|个|人|次|项|元|席|页)?\s*(?:及|或)?(?:以上|以下|以内|左右|内|起)/g,
];
export const NUMERIC_CONSTRAINT_SURFACE_TERMS = new Set([
  "at",
  "equal",
  "exactly",
  "fewer",
  "just",
  "least",
  "less",
  "limit",
  "limited",
  "maximum",
  "minimum",
  "more",
  "most",
  "only",
  "than",
  "to",
  "up",
  "within",
  "above",
  "about",
  "almost",
  "approx",
  "approximately",
  "around",
  "below",
  "capped",
  "ca",
  "circa",
  "close",
  "except",
  "excepting",
  "excluding",
  "exceeding",
  "greater",
  "higher",
  "max",
  "min",
  "nearly",
  "near",
  "outside",
  "over",
  "roughly",
  "tops",
  "under",
  "lower",
  "longer",
  "上",
  "下",
  "不",
  "于",
  "以内",
  "以",
  "仅",
  "低",
  "及",
  "右",
  "大",
  "多",
  "最",
  "少",
  "左",
  "恰",
  "或",
  "概",
  "约",
  "至",
  "超",
  "近",
  "过",
  "高",
  "好",
]);
export const MONTH_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi;
export const DATE_PATTERN = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g;
export const CODE_PATTERN = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]{1,})+\b/g;
export const CLAIM_SPLIT_PATTERN = /(?<=[.!?。！？])\s+|[;；]+/gi;
export const SOURCE_AFTER_PUNCTUATION_PATTERN =
  /([.!?。！？])\s*((?:\[(?:source|来源)\s*\d+\]\s*)+)/gi;
export const DOTTED_ABBREVIATION_PATTERN =
  /\b(?:(?:[A-Za-z]\.){2,}|(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|No)\.)/g;
export const PROTECTED_PERIOD = "";
export const CLAIM_PREDICATE_PATTERN =
  /\b(?:is|are|was|were|be|been|being|may|must|can|cannot|can't|will|shall|should|has|have|had|allow(?:ed|s|ing)?|permit(?:s|ted|ting)?|prohibit(?:ed|s|ing)?|require(?:d|s|ing)?|include(?:d|s|ing)?|provide(?:d|s|ing)?|limit(?:ed|s|ing)?|specif(?:y|ies|ied)|state(?:d|s|ing)?|use(?:d|s|ing)?|refer(?:red|s|ring)?|receive(?:d|s|ing)?|exist(?:ed|s|ing)?|complete(?:d|s|ing)?|differ(?:s|ed|ent)?)\b/i;
export const SUPPORT_TOKEN_OVERLAP_THRESHOLD = 0.6;
export const STRUCTURAL_SECTION_HEADING_PATTERN =
  /^(?:risk review|contract summary|document comparison|common ground|agreements?|differences?|missing terms?|parties|key terms?|obligations?|deadlines?|unknowns?|risks?|gaps?|gaps? or uncertainty|conflicts?(?: or exceptions?)?|exceptions?|evidence limits?|executive summary|key findings|summary|per document|evidence by document|recommended next questions|摘要|逐文档|共同点|差异|缺口或不确定性)$/i;
export const COMPARISON_RELATION_PATTERN =
  /(?:\b(?:all|both|each|either|differ(?:s|ent)?|while|whereas|only|same|aligns?|conflicts?|versus|vs)\b|(?:两份|所有|各)(?:文档|政策|手册|来源).*都|而|但是?|然而|相比|相较)/i;
export const CONTRAST_RELATION_PATTERN =
  /(?:\b(?:but|differ(?:s|ent)?|however|unlike|while|whilst|whereas|yet|versus|vs)\b|而|但是?|然而|相比|相较)/i;
export const AGREEMENT_RELATION_PATTERN =
  /(?:\b(?:both|all(?:\s+(?:\w+|\d+)){0,2}|each)\s+(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)\b|(?:两份|所有|各)(?:文档|政策|手册|来源).*都)/i;
export const BARE_BOTH_AGREEMENT_PATTERN =
  /^\s*(?:[-*]\s*)?both\s+(?:allow(?:ed|s|ing)?|permit(?:s|ted|ting)?|prohibit(?:ed|s|ing)?|require(?:d|s|ing)?|include(?:d|s|ing)?|provide(?:d|s|ing)?|limit(?:ed|s|ing)?|state(?:d|s|ing)?|specif(?:y|ies|ied)|use(?:d|s|ing)?|complete(?:d|s|ing)?)\b/i;
export const EITHER_DOCUMENT_RELATION_PATTERN =
  /\beither\s+(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)\b/i;
export const EXCLUSIVE_RELATION_PATTERN =
  /\b(?:only|solely|exclusively|alone)\b/i;
export const GENERIC_EXCLUSIVE_DOCUMENT_PATTERN =
  /\bonly\s+(?:(?:the\s+)?(?:first|second|former|latter|one)\s+)?(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)\b/i;
export const SOURCE_SCOPED_EXCLUSIVE_PATTERN =
  /^\s*[-*]?\s*only\s+(?:is|are|was|were|allows?|permits?|prohibits?|requires?|includes?|provides?|limits?|states?|specifies?)\b/i;
export const NO_DIFFERENCE_RELATION_PATTERN =
  /\b(?:no\b.*\bdifferences?\b|no\b.*\b(?:conflicting values?|conflicts?)\b.*\b(?:retrieved|cited|evidence)\b|retrieved evidence aligns on (?:the )?key facts)\b/i;
export const EVIDENCE_SCOPED_NO_DIFFERENCE_PATTERN =
  /\b(?:no\b.*\b(?:material differences?|conflicting values?|conflicts?)\b.*\b(?:retrieved|cited|evidence)|retrieved evidence aligns on (?:the )?key facts)\b/i;
export const COMPARISON_SCAFFOLD_TERMS = new Set([
  "all",
  "both",
  "either",
  "differ",
  "differs",
  "each",
  "agreements",
  "contracts",
  "handbooks",
  "only",
  "sources",
  "whereas",
  "while",
  "两",
  "份",
  "文",
  "档",
  "都",
  "各",
]);
export const CONTRAST_STYLE_TERMS = new Set([
  "clearly",
  "explicitly",
  "expressly",
  "formally",
  "specifically",
]);
export const NEGATED_PERMISSION_PATTERN =
  /\b(?:not\s+(?:allowed|permitted)|cannot|can't|must\s+not|mustn't|may\s+not|needn't|shouldn't)\b/gi;
export const NEGATED_PROHIBITION_PATTERN =
  /\b(?:not|never)\s+(?:prohibited|forbidden|disallowed)\b/i;
export const ALLOW_MODALITY_PATTERN =
  /(?:\b(?:allow(?:ed|s|ing)?|permit(?:s|ted|ting)?|may)\b|允许|可以)/i;
export const PROHIBIT_MODALITY_PATTERN =
  /(?:\b(?:prohibit(?:ed|s|ing)?|forbid(?:s|den|ding)?|disallow(?:ed|s|ing)?)\b|禁止|不得|不能|不可)/i;
export const NEGATED_REQUIREMENT_PATTERN =
  /(?:\b(?:not\s+(?:required|necessary|mandatory|compulsory)|does?\s+not\s+require|needn't|optional|voluntary|waived|unnecessary|independent(?:ly)?\s+of|free\s+from|exempt(?:ed)?\s+from|without\b[^.!?。！？;；]*\b(?:approval|permission|requirement))\b|无需|不需要|非必须|可选|自愿|豁免)/gi;
export const DOUBLE_NEGATIVE_REQUIREMENT_PATTERN =
  /\b(?:cannot|can't|may\s+not|must\s+not|mustn't|should\s+not|shouldn't)\b[^.!?。！？;；]*\bwithout\b[^.!?。！？;；]*\b(?:approval|permission|requirement)\b/i;
export const REQUIRE_MODALITY_PATTERN =
  /(?:\b(?:require(?:d|s|ing)?|must|shall|mandatory|compulsory|mandate(?:d|s|ing)?|need(?:ed|s|ing)?|necessary|obligat(?:e|ed|es|ing|ion|ory))\b|要求|需要|必须|应当)/i;
export const RECOMMEND_MODALITY_PATTERN = /\b(?:should|ought\s+to|recommended)\b/i;
export const NEGATIVE_POLARITY_PATTERN =
  /(?:\b(?:no\s+longer|no|not|never|without|absent|missing|lacks?|cannot|can't|mustn't|needn't|shouldn't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|hadn't)\b|不|未|无|禁止|不得|不能|不可|没有|缺少)/i;
export const NEGATIVE_POLARITY_TERMS = new Set([
  "absent",
  "lack",
  "lacks",
  "missing",
  "never",
  "without",
]);
export const MODALITY_CLAUSE_SPLIT_PATTERN =
  /(?<=[.!?。！？])\s+|\n+|[;；]+\s*|(?:[,，]\s*)?\b(?:but|however|whereas|while|whilst|yet)\b\s*|(?:[,，]\s*)?(?:而|但是?|然而|相比之下|相较之下)\s*/gi;
export const MODALITY_CLAIM_TERMS = new Set([
  "allow",
  "allowed",
  "allows",
  "allowing",
  "permit",
  "permits",
  "permitted",
  "permitting",
  "prohibit",
  "prohibited",
  "prohibits",
  "prohibiting",
  "forbid",
  "forbids",
  "forbidden",
  "forbidding",
  "disallow",
  "disallowed",
  "disallows",
  "disallowing",
  "require",
  "required",
  "requires",
  "requiring",
  "must",
  "mandatory",
  "mandate",
  "mandated",
  "mandates",
  "mandating",
  "need",
  "needed",
  "needs",
  "needing",
  "necessary",
  "optional",
  "unnecessary",
  "independent",
  "independently",
  "obligate",
  "obligated",
  "obligates",
  "obligation",
  "obligatory",
  "shall",
  "should",
  "compulsory",
  "voluntary",
  "waived",
]);
export const DOCUMENT_ATTRIBUTION_PREPOSITIONS = new Set([
  "according",
  "from",
  "in",
  "under",
  "versus",
  "vs",
  "whereas",
  "while",
]);
export const DOCUMENT_ATTRIBUTION_VERBS = new Set([
  "allows",
  "limits",
  "permits",
  "provides",
  "require",
  "required",
  "requires",
  "refers",
  "restricts",
  "says",
  "sets",
  "specifies",
  "states",
  "uses",
]);
export const DOCUMENT_IDENTITY_TERMS = new Set([
  "agreement",
  "archive",
  "contract",
  "doc",
  "document",
  "handbook",
  "manual",
  "policy",
  "report",
  "source",
]);
export const CHINESE_DOCUMENT_IDENTITY_PATTERN =
  /(?:文档|政策|手册|合同|协议|报告|来源)/;
export const CHINESE_ATTRIBUTION_PREFIX_PATTERN = /(?:根据|按照|依照|在|从)$/;
export const CHINESE_ATTRIBUTION_VERB_PATTERN =
  /^(?:允许|要求|需要|必须|应当|规定|限制|禁止|不得|包含|包括|提供|说明|指出|采用|使用|为|有|无)/;
export const FILE_EXTENSION_TERMS = new Set([
  "doc",
  "docx",
  "md",
  "pdf",
  "rtf",
  "txt",
]);
export const CHINESE_MODALITY_SURFACE_PATTERN =
  /允许|可以|禁止|不得|不能|不可|要求|需要|必须|应当|无需|不需要|非必须|可选|自愿|豁免/g;
export const FACT_TERM_ALIASES = new Map([
  ["complete", "complete"],
  ["completed", "complete"],
  ["completing", "complete"],
  ["completion", "complete"],
  ["remotely", "remote"],
]);
export const REPORTIVE_STATED_WRAPPER_PATTERN =
  /\b(is|was)\s+stated\s+to\s+be\b/gi;
export const CLAIM_LEAD_LABEL_PATTERN =
  /^(?:risk|unsupported|unknown|gap|difference|agreement|parties|key terms?|obligations?|deadlines?|finding)\s*:\s*/i;
