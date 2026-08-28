import { bootstrapHostedRoles } from "./bootstrap.js";

try {
  await bootstrapHostedRoles();
  process.stdout.write("hosted roles ready (sg_app, sg_migrator)\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
