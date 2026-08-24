import { findVendorName } from "./vendor-list.js";

const IMPORT_SOURCE_PARENTS = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSImportType",
]);

function isModuleSpecifier(node, parent) {
  if (!parent) return false;
  if (IMPORT_SOURCE_PARENTS.has(parent.type) && parent.source === node) return true;
  if (
    parent.type === "CallExpression" &&
    parent.callee.type === "Identifier" &&
    parent.callee.name === "require" &&
    parent.arguments[0] === node
  ) {
    return true;
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid third-party product, vendor, and competitor names outside module specifiers.",
    },
    schema: [],
    messages: {
      vendor:
        'Third-party vendor name "{{name}}" is forbidden here. Library module specifiers are the only exception.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    function checkText(node, text) {
      const name = findVendorName(text);
      if (name !== null) {
        context.report({ node, messageId: "vendor", data: { name } });
      }
    }

    return {
      Identifier(node) {
        checkText(node, node.name);
      },
      PrivateIdentifier(node) {
        checkText(node, node.name);
      },
      JSXIdentifier(node) {
        checkText(node, node.name);
      },
      JSXText(node) {
        checkText(node, node.value);
      },
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (isModuleSpecifier(node, node.parent)) return;
        checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.raw);
      },
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          checkText(comment, comment.value);
        }
      },
    };
  },
};
