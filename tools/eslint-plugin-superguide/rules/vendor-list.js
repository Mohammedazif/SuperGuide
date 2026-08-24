export const UNAMBIGUOUS_VENDOR_NAMES = [
  "argide",
  "pendo",
  "walkme",
  "whatfix",
  "userflow",
  "userpilot",
  "usetiful",
  "appcues",
  "frigade",
  "skippr",
  "copilotkit",
  "commandbar",
  "superflows",
  "intercom",
  "zendesk",
  "freshdesk",
  "helpscout",
  "decagon",
  "openai",
  "langchain",
  "llamaindex",
  "pinecone",
  "weaviate",
  "qdrant",
  "milvus",
  "redis",
  "kafka",
  "rabbitmq",
  "bullmq",
  "celery",
  "turborepo",
  "segment.io",
  "amplitude",
  "mixpanel",
  "fullstory",
  "logrocket",
  "hotjar",
  "smartlook",
  "temporal.io",
];

const ESCAPED = UNAMBIGUOUS_VENDOR_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

export const VENDOR_PATTERN = new RegExp(`(?<![a-z0-9])(${ESCAPED.join("|")})(?![a-z0-9])`, "i");

export function findVendorName(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const match = VENDOR_PATTERN.exec(text);
  return match ? match[1] : null;
}
