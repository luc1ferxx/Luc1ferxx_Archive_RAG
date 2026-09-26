const VARIABLE_PATTERN = /\{\{|\}\}|\{([^{}]+)\}/g;

const formatTemplate = (template, values) => {
  return template.replace(VARIABLE_PATTERN, (match, name) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (!(name in values)) {
      throw new Error(`Missing value for variable "${name}"`);
    }
    return values[name];
  });
};

// `source` is the unrendered template text. The prompt registry fingerprints
// it, so a report or trace can say exactly which template produced a call.
export const createPromptTemplate = (template) => ({
  format: (values) => formatTemplate(template, values),
  source: template,
});

export const createChatPromptTemplate = (messages) => ({
  invoke: (values) => ({
    messages: messages.map(([role, template]) => ({
      role,
      content: formatTemplate(template, values),
    })),
  }),
  source: messages.map(([role, template]) => `${role}:\n${template}`).join("\n\n"),
});
