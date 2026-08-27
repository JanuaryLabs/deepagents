import { z } from 'zod';

import { RESERVED_ELEMENT_ATTRIBUTES } from './types.ts';

const kebabName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const attributeName = z
  .string()
  .min(1)
  .max(64)
  .regex(kebabName)
  .refine((attribute) => !RESERVED_ELEMENT_ATTRIBUTES.has(attribute), {
    message:
      'Attribute is reserved: the markdown sanitizer rewrites it to "user-content-<value>". Use a domain attribute instead (e.g. "param").',
  });

export const elementSchema = z.object({
  name: z.string().min(1).max(64).regex(kebabName),
  description: z.string().max(512).optional(),
  allowedAttributes: z.array(attributeName).max(20),
});

export const elementsSchema = z.array(elementSchema).max(100).optional();
