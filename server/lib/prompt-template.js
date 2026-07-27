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

export const createPromptTemplate = (template) => ({
  format: (values) => formatTemplate(template, values),
});

export const createChatPromptTemplate = (messages) => ({
  invoke: (values) => ({
    messages: messages.map(([role, template]) => ({
      role,
      content: formatTemplate(template, values),
    })),
  }),
});
