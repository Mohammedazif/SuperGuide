function reportDeclarators(context, node) {
  if (node.kind === "const") return;
  for (const declarator of node.declarations) {
    const name = declarator.id.type === "Identifier" ? declarator.id.name : "<destructured>";
    context.report({ node: declarator, messageId: "mutable", data: { name } });
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid module-level mutable bindings so no shared package can accumulate cached state.",
    },
    schema: [],
    messages: {
      mutable:
        'Module-level mutable binding "{{name}}" is forbidden. Construct dependencies and inject them.',
    },
  },
  create(context) {
    return {
      "Program > VariableDeclaration"(node) {
        reportDeclarators(context, node);
      },
      "Program > ExportNamedDeclaration > VariableDeclaration"(node) {
        reportDeclarators(context, node);
      },
    };
  },
};
