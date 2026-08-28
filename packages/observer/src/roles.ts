const INPUT_TYPE_ROLES: Record<string, string> = {
  button: "button",
  checkbox: "checkbox",
  email: "textbox",
  image: "button",
  number: "spinbutton",
  password: "textbox",
  radio: "radio",
  range: "slider",
  reset: "button",
  search: "searchbox",
  submit: "button",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
};

const TAG_ROLES: Record<string, string> = {
  A: "link",
  ARTICLE: "article",
  ASIDE: "complementary",
  BUTTON: "button",
  DIALOG: "dialog",
  FIELDSET: "group",
  FOOTER: "contentinfo",
  FORM: "form",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  HEADER: "banner",
  LI: "listitem",
  MAIN: "main",
  NAV: "navigation",
  OL: "list",
  OPTION: "option",
  OUTPUT: "status",
  PROGRESS: "progressbar",
  SECTION: "region",
  SELECT: "combobox",
  SUMMARY: "button",
  TABLE: "table",
  TBODY: "rowgroup",
  TD: "cell",
  TEXTAREA: "textbox",
  TH: "columnheader",
  TR: "row",
  UL: "list",
};

export function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role");
  if (explicit !== null && explicit.trim().length > 0) return explicit.trim().split(/\s+/)[0] ?? null;

  if (element.tagName === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return INPUT_TYPE_ROLES[type] ?? "textbox";
  }
  if (element.tagName === "A") {
    return element.hasAttribute("href") ? "link" : null;
  }
  return TAG_ROLES[element.tagName] ?? null;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);

// Not interactive; the agent must see them so element_state can read a landed change.
const OBSERVABLE_ROLES = new Set([
  "alert",
  "alertdialog",
  "dialog",
  "note",
  "progressbar",
  "status",
  "tooltip",
]);

export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

export function isObservableRole(role: string): boolean {
  return OBSERVABLE_ROLES.has(role);
}

export function isLandmarkRole(role: string): boolean {
  return LANDMARK_ROLES.has(role);
}

export function isHeadingRole(role: string): boolean {
  return role === "heading";
}
