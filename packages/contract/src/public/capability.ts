import { z } from "zod";
import { riskClassSchema } from "./primitives.js";

export const capabilityDescriptorSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  description: z.string().min(1).max(400),
  risk: riskClassSchema,
  parameters: z.record(z.string(), z.unknown()),
});
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;

export const capabilityRegistrationSchema = z.object({
  capabilities: z.array(capabilityDescriptorSchema).max(64),
});
export type CapabilityRegistration = z.infer<typeof capabilityRegistrationSchema>;
